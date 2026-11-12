import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  ageInDays,
  type AddRemittanceLinesBody,
  type CodStatus,
  type ConfirmRemittanceBody,
  type CreateRemittanceBody,
  type CursorPage,
  RemittableCodStatuses,
  RemittanceLimits,
  type RemittanceLineOutcome,
  RemittanceStatus,
  remittanceTotals,
  SettlingOutcomes,
  ShipmentResourceTypes,
  type UpdateRemittanceLineBody
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { RemittancesService as RemittanceWrites } from '@platform/core/shipping'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type { ListRemittancesQuery } from './remittances.schemas'
import {
  type PendingConnectionView,
  type PendingShipmentView,
  REMITTANCE_SELECT,
  type RemittanceDetailView,
  type RemittanceLineView,
  type RemittanceRow,
  type RemittanceTotalsView,
  type RemittanceView,
  remittanceViewOf
} from './remittances.views'

const ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const

// The remittances of the store of the request (TDD_17 §4.15, §6): the permission of each route is checked by the controller and
// the store is the one TenantGuard resolved. RemittanceWrites (libs/core/shipping) is the only writer of a remittance and of
// the COD status it gives a shipment; this adds the audit entry of each settlement and the shapes of the answers.
@Injectable()
export class RemittancesApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: RemittanceWrites,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string, query: ListRemittancesQuery): Promise<CursorPage<RemittanceView>> {
    const { cursor, limit } = query
    const rows = await this.prisma.client.codRemittance.findMany({
      where: {
        storeId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.connectionId === undefined ? {} : { connectionId: query.connectionId }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: REMITTANCE_SELECT,
      orderBy: [...ORDER],
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const live = await this.draftTotals(
      storeId,
      page.filter(row => row.status === String(RemittanceStatus.DRAFT)).map(row => row.id)
    )
    const last = page.at(-1)
    return {
      data: page.map(row => remittanceViewOf(row, live.get(row.id) ?? storedTotals(row))),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(storeId: string, remittanceId: string): Promise<RemittanceDetailView> {
    const row = await this.rowOf(storeId, remittanceId)
    const lines = await this.prisma.client.codRemittanceLine.findMany({
      where: { storeId, remittanceId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        position: true,
        guideNumber: true,
        shipmentId: true,
        reportedCents: true,
        reportedFeeCents: true,
        expectedCents: true,
        outcome: true,
        excluded: true,
        note: true,
        shipment: { select: { order: { select: { orderNumber: true } } } }
      }
    })
    const views: RemittanceLineView[] = lines.map(line => ({
      id: line.id,
      position: line.position,
      guideNumber: line.guideNumber,
      shipmentId: line.shipmentId,
      orderNumber: line.shipment?.order.orderNumber ?? null,
      reportedCents: line.reportedCents,
      reportedFeeCents: line.reportedFeeCents,
      expectedCents: line.expectedCents,
      differenceCents: line.expectedCents === null ? null : line.reportedCents - line.expectedCents,
      outcome: line.outcome as RemittanceLineOutcome,
      excluded: line.excluded,
      note: line.note
    }))
    const totals =
      row.status === String(RemittanceStatus.DRAFT)
        ? remittanceTotals(
            lines.map(line => ({
              outcome: line.outcome as RemittanceLineOutcome,
              excluded: line.excluded,
              reportedCents: line.reportedCents,
              reportedFeeCents: line.reportedFeeCents,
              expectedCents: line.expectedCents
            }))
          )
        : storedTotals(row)
    return { ...remittanceViewOf(row, totals), lines: views }
  }

  // What is still owed, per connection (TDD_17 §4.15): every shipment that waits for a remittance or whose last one differed.
  // The list of shipments comes only when one connection is asked for, oldest first and bounded.
  async pending(storeId: string, connectionId?: string): Promise<PendingConnectionView[]> {
    const where = {
      storeId,
      codStatus: { in: [...RemittableCodStatuses] },
      ...(connectionId === undefined ? {} : { connectionId })
    }
    const groups = await this.prisma.client.shipment.groupBy({
      by: ['connectionId'],
      where,
      _count: { _all: true },
      _sum: { codExpectedCents: true, codRemittedCents: true },
      _min: { deliveredAt: true }
    })
    if (groups.length === 0) return []
    const connections = await this.prisma.client.carrierConnection.findMany({
      where: { storeId, id: { in: groups.map(group => group.connectionId) } },
      select: { id: true, displayName: true, carrierId: true }
    })
    const now = new Date()
    const views: PendingConnectionView[] = groups.map(group => {
      const connection = connections.find(item => item.id === group.connectionId)
      const oldest = group._min.deliveredAt
      return {
        connectionId: group.connectionId,
        connectionName: connection?.displayName ?? '',
        carrierId: connection?.carrierId ?? '',
        count: group._count._all,
        totalOwedCents: (group._sum.codExpectedCents ?? 0) - (group._sum.codRemittedCents ?? 0),
        oldestDeliveredAt: oldest?.toISOString() ?? null,
        oldestAgeDays: oldest === null ? null : ageInDays(oldest, now),
        shipments: [],
        truncated: false
      }
    })
    views.sort(
      (a, b) => b.totalOwedCents - a.totalOwedCents || a.connectionId.localeCompare(b.connectionId)
    )
    if (connectionId === undefined) return views
    const only = views[0]
    if (only === undefined) return views
    const rows = await this.prisma.client.shipment.findMany({
      where,
      select: {
        id: true,
        guideNumber: true,
        codStatus: true,
        codExpectedCents: true,
        codRemittedCents: true,
        deliveredAt: true,
        order: { select: { orderNumber: true } }
      },
      orderBy: [{ deliveredAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: RemittanceLimits.PENDING_SHIPMENTS_MAX + 1
    })
    only.truncated = rows.length > RemittanceLimits.PENDING_SHIPMENTS_MAX
    only.shipments = rows
      .slice(0, RemittanceLimits.PENDING_SHIPMENTS_MAX)
      .map((row): PendingShipmentView => {
        const expected = row.codExpectedCents ?? 0
        return {
          shipmentId: row.id,
          orderNumber: row.order.orderNumber,
          guideNumber: row.guideNumber,
          codStatus: row.codStatus as CodStatus,
          expectedCents: expected,
          remittedCents: row.codRemittedCents,
          owedCents: expected - (row.codRemittedCents ?? 0),
          deliveredAt: row.deliveredAt?.toISOString() ?? null,
          ageDays: row.deliveredAt === null ? null : ageInDays(row.deliveredAt, now)
        }
      })
    return views
  }

  async create(
    storeId: string,
    body: CreateRemittanceBody,
    actor: Actor
  ): Promise<RemittanceDetailView> {
    const created = await this.writes.createDraft(storeId, body, refOf(actor))
    return this.get(storeId, created.id)
  }

  async addLines(
    storeId: string,
    remittanceId: string,
    body: AddRemittanceLinesBody
  ): Promise<RemittanceDetailView> {
    await this.writes.addLines(storeId, remittanceId, body)
    return this.get(storeId, remittanceId)
  }

  async updateLine(
    storeId: string,
    remittanceId: string,
    lineId: string,
    patch: UpdateRemittanceLineBody
  ): Promise<RemittanceDetailView> {
    await this.writes.updateLine(storeId, remittanceId, lineId, patch)
    return this.get(storeId, remittanceId)
  }

  async discard(storeId: string, remittanceId: string): Promise<void> {
    await this.writes.discardDraft(storeId, remittanceId)
  }

  async confirm(
    storeId: string,
    remittanceId: string,
    body: ConfirmRemittanceBody,
    actor: Actor
  ): Promise<RemittanceDetailView> {
    const done = await this.writes.confirm(storeId, remittanceId, body, refOf(actor))
    this.record(storeId, AuditAction.REMITTANCE_CONFIRMED, remittanceId, actor, {
      connectionId: done.connectionId,
      settled: done.settled,
      discrepancies: done.discrepancies,
      expectedCents: done.expectedCents,
      reportedCents: done.reportedCents,
      feeCents: done.feeCents
    })
    return this.get(storeId, remittanceId)
  }

  async void(storeId: string, remittanceId: string, actor: Actor): Promise<RemittanceDetailView> {
    const done = await this.writes.void(storeId, remittanceId, refOf(actor))
    this.record(storeId, AuditAction.REMITTANCE_VOIDED, remittanceId, actor, {
      connectionId: done.connectionId,
      restored: done.restored
    })
    return this.get(storeId, remittanceId)
  }

  // ---------------------------------------------------------------------------------------------- support

  private async rowOf(storeId: string, remittanceId: string): Promise<RemittanceRow> {
    const row = await this.prisma.client.codRemittance.findFirst({
      where: { id: remittanceId, storeId },
      select: REMITTANCE_SELECT
    })
    if (row === null) throw resourceNotFound('remittance')
    return row
  }

  // The live totals of the drafts of a page: only the lines that would settle a shipment count (what confirming writes)
  private async draftTotals(
    storeId: string,
    draftIds: readonly string[]
  ): Promise<Map<string, RemittanceTotalsView>> {
    const totals = new Map<string, RemittanceTotalsView>()
    if (draftIds.length === 0) return totals
    const sums = await this.prisma.client.codRemittanceLine.groupBy({
      by: ['remittanceId'],
      where: {
        storeId,
        remittanceId: { in: [...draftIds] },
        excluded: false,
        outcome: { in: [...SettlingOutcomes] }
      },
      _sum: { expectedCents: true, reportedCents: true, reportedFeeCents: true }
    })
    for (const sum of sums) {
      const expectedCents = sum._sum.expectedCents ?? 0
      const reportedCents = sum._sum.reportedCents ?? 0
      totals.set(sum.remittanceId, {
        expectedCents,
        reportedCents,
        feeCents: sum._sum.reportedFeeCents ?? 0,
        differenceCents: reportedCents - expectedCents
      })
    }
    for (const id of draftIds) {
      if (!totals.has(id)) {
        totals.set(id, { expectedCents: 0, reportedCents: 0, feeCents: 0, differenceCents: 0 })
      }
    }
    return totals
  }

  private record(
    storeId: string,
    action: (typeof AuditAction)[keyof typeof AuditAction],
    remittanceId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ShipmentResourceTypes.REMITTANCE,
      resourceId: remittanceId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

function storedTotals(row: RemittanceRow): RemittanceTotalsView {
  return {
    expectedCents: row.expectedCents,
    reportedCents: row.reportedCents,
    feeCents: row.feeCents,
    differenceCents: row.reportedCents - row.expectedCents
  }
}

function refOf(actor: Actor): { type: 'user'; id: string } {
  return { type: 'user', id: actor.userId }
}
