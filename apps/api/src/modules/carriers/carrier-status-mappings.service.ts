import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, lockStoreScope, PrismaService } from '@platform/core/database'
import {
  CarrierConnectionStatus,
  CarrierLockScopes,
  CarrierStatusLimits,
  CarrierStatusMappingSource,
  type CursorPage,
  normalizeProviderStatusCode,
  ShipmentStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import {
  encodeMappingCursor,
  type ListStatusMappingsQuery,
  type ListUnmappedStatusesQuery,
  type PutStatusMappingBody
} from './carrier-status-mappings.schemas'

export interface StatusMappingView {
  providerCode: string
  label: string | null
  // `null`: the owner chose to ignore the code on purpose
  status: ShipmentStatus | null
  source: CarrierStatusMappingSource
  updatedAt: string
}

export interface UnmappedStatusView {
  providerCode: string
  sampleRawStatus: string
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
}

const MAPPING_SELECT = {
  id: true,
  providerCode: true,
  label: true,
  status: true,
  source: true,
  updatedAt: true
} as const

interface MappingRow {
  providerCode: string
  label: string | null
  status: string | null
  source: string
  updatedAt: Date
}

const SHIPMENT_STATUSES = Object.values(ShipmentStatus)

function viewOf(row: MappingRow): StatusMappingView {
  return {
    providerCode: row.providerCode,
    label: row.label,
    status: SHIPMENT_STATUSES.find(status => status === row.status) ?? null,
    source:
      row.source === String(CarrierStatusMappingSource.CUSTOM)
        ? CarrierStatusMappingSource.CUSTOM
        : CarrierStatusMappingSource.DEFAULT,
    updatedAt: row.updatedAt.toISOString()
  }
}

// The same refusal as the rest of the connection: a disconnected one takes no edit
function notActive(): PlatformException {
  return new PlatformException(
    ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
    'the carrier connection is disconnected',
    HttpStatusCodes.CONFLICT
  )
}

// What a carrier's code means for one connection (TDD_17 §4.17): the rows the owner can read and change, and the codes that
// arrived with no meaning. Every read and write names the store of the request, and the connection is read first with that
// store, so the connection of another store is the same 404 as one that does not exist. A change is audited with the code and
// the old and new status. Editing a row changes future events only: no status already applied is rewritten.
@Injectable()
export class CarrierStatusMappingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CarrierRegistry,
    private readonly audit: AuditService
  ) {}

  async list(
    storeId: string,
    connectionId: string,
    query: ListStatusMappingsQuery
  ): Promise<CursorPage<StatusMappingView>> {
    await this.connectionOf(storeId, connectionId)
    const { cursor, limit } = query
    const rows = await this.prisma.client.carrierStatusMapping.findMany({
      where: {
        storeId,
        connectionId,
        ...(cursor === undefined ? {} : { providerCode: { gt: cursor } })
      },
      select: MAPPING_SELECT,
      orderBy: { providerCode: 'asc' },
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(viewOf),
      nextCursor: hasMore && last !== undefined ? encodeMappingCursor(last.providerCode) : null,
      hasMore
    }
  }

  async listUnmapped(
    storeId: string,
    connectionId: string,
    query: ListUnmappedStatusesQuery
  ): Promise<CursorPage<UnmappedStatusView>> {
    await this.connectionOf(storeId, connectionId)
    const { cursor, limit } = query
    // Newest first by the first sighting, which never moves (a busy code must not jump over the cursor); the cursor holds the (firstSeenAt, id) of the last row of the page
    const rows = await this.prisma.client.carrierUnmappedStatus.findMany({
      where: {
        storeId,
        connectionId,
        resolvedAt: null,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { firstSeenAt: { lt: cursor.createdAt } },
                { firstSeenAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: {
        id: true,
        providerCode: true,
        sampleRawStatus: true,
        occurrences: true,
        firstSeenAt: true,
        lastSeenAt: true
      },
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => ({
        providerCode: row.providerCode,
        sampleRawStatus: row.sampleRawStatus,
        occurrences: row.occurrences,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString()
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.firstSeenAt, id: last.id })
          : null,
      hasMore
    }
  }

  // Creates the row or changes it (`source` becomes custom) and marks the waiting code as resolved. The replay of the events
  // already stored under that code is the job REPROCESS_CARRIER_EVENTS of Step 4.8 PR C2c.
  async put(
    storeId: string,
    connectionId: string,
    providerCode: string,
    body: PutStatusMappingBody,
    actor: Actor,
    retry = true
  ): Promise<StatusMappingView> {
    const connection = await this.connectionOf(storeId, connectionId)
    if (connection.status === String(CarrierConnectionStatus.DISABLED)) throw notActive()
    const plugin = this.registry.find(connection.carrierId)
    const catalogLabel = plugin
      ?.statusCatalog()
      .find(entry => normalizeProviderStatusCode(entry.code) === providerCode)?.label

    let result: Awaited<ReturnType<CarrierStatusMappingsService['writeMapping']>>
    try {
      result = await this.writeMapping(
        storeId,
        connectionId,
        providerCode,
        body,
        actor,
        catalogLabel
      )
    } catch (error) {
      // Two PUTs of a code with no row at once: the loser finds the row of the winner and changes it
      if (retry && isUniqueViolation(error)) {
        return this.put(storeId, connectionId, providerCode, body, actor, false)
      }
      throw error
    }

    this.record(storeId, connectionId, actor, providerCode, result.before, body.status)
    return viewOf(result.row)
  }

  private writeMapping(
    storeId: string,
    connectionId: string,
    providerCode: string,
    body: PutStatusMappingBody,
    actor: Actor,
    catalogLabel: string | undefined
  ): Promise<{ row: MappingRow; before: MappingRow | null }> {
    return this.prisma.transaction(async tx => {
      // One writer at a time per store for the rows of a connection: the count that bounds them is read and then written
      await lockStoreScope(tx, storeId, CarrierLockScopes.CONNECTIONS)
      // Read again under the lock: a disconnect or a removal that came first is not written over
      const live = await tx.carrierConnection.findFirst({
        where: { id: connectionId, storeId },
        select: { status: true }
      })
      if (live === null) throw resourceNotFound('carrier connection')
      if (live.status === String(CarrierConnectionStatus.DISABLED)) throw notActive()
      const existing = await tx.carrierStatusMapping.findFirst({
        where: { storeId, connectionId, providerCode },
        select: MAPPING_SELECT
      })
      const waiting = await tx.carrierUnmappedStatus.findFirst({
        where: { storeId, connectionId, providerCode },
        select: { sampleRawStatus: true }
      })
      const data = {
        status: body.status,
        source: CarrierStatusMappingSource.CUSTOM,
        updatedBy: actor.userId
      }
      let row: MappingRow
      if (existing === null) {
        const held = await tx.carrierStatusMapping.count({ where: { storeId, connectionId } })
        if (held >= CarrierStatusLimits.MAX_MAPPINGS_PER_CONNECTION) {
          throw resourceConflict('the connection holds as many status mappings as it may')
        }
        row = await tx.carrierStatusMapping.create({
          data: {
            storeId,
            connectionId,
            providerCode,
            label: catalogLabel ?? waiting?.sampleRawStatus ?? providerCode,
            ...data
          },
          select: MAPPING_SELECT
        })
      } else {
        const changed = await tx.carrierStatusMapping.updateMany({
          where: { id: existing.id, storeId, connectionId },
          data
        })
        // Removed between the read and the write: the owner is not told "saved" about a row that is not there
        if (changed.count !== 1) throw resourceConflict('the status mapping changed meanwhile')
        row = { ...existing, ...data, updatedAt: new Date() }
      }
      // The code itself, and the composite codes of its reasons that have no row of their own: the plain mapping now answers
      // them, so they no longer wait
      const waitingRows = await tx.carrierUnmappedStatus.findMany({
        where: {
          storeId,
          connectionId,
          resolvedAt: null,
          OR: [{ providerCode }, { providerCode: { startsWith: `${providerCode}:` } }]
        },
        select: { id: true, providerCode: true }
      })
      const ownRows = new Set(
        (
          await tx.carrierStatusMapping.findMany({
            where: {
              storeId,
              connectionId,
              providerCode: { in: waitingRows.map(r => r.providerCode) }
            },
            select: { providerCode: true }
          })
        ).map(row => row.providerCode)
      )
      const resolvable = waitingRows.filter(
        row => row.providerCode === providerCode || !ownRows.has(row.providerCode)
      )
      await tx.carrierUnmappedStatus.updateMany({
        where: { storeId, connectionId, id: { in: resolvable.map(row => row.id) } },
        data: { resolvedAt: new Date() }
      })
      return { row, before: existing }
    })
  }

  // Back to what the plugin says: a code of its catalog with a default status gets its row as it was seeded, and any other
  // code loses its row (it is unmapped again when it next arrives)
  async remove(
    storeId: string,
    connectionId: string,
    providerCode: string,
    actor: Actor
  ): Promise<void> {
    const connection = await this.connectionOf(storeId, connectionId)
    if (connection.status === String(CarrierConnectionStatus.DISABLED)) throw notActive()
    const entry = this.registry
      .find(connection.carrierId)
      ?.statusCatalog()
      .find(candidate => normalizeProviderStatusCode(candidate.code) === providerCode)

    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreScope(tx, storeId, CarrierLockScopes.CONNECTIONS)
      // Read again under the lock: a disconnect that came first is not written over
      const live = await tx.carrierConnection.findFirst({
        where: { id: connectionId, storeId },
        select: { status: true }
      })
      if (live === null) throw resourceNotFound('carrier connection')
      if (live.status === String(CarrierConnectionStatus.DISABLED)) throw notActive()
      const before = await tx.carrierStatusMapping.findFirst({
        where: { storeId, connectionId, providerCode },
        select: MAPPING_SELECT
      })
      if (before === null) throw resourceNotFound('status mapping')
      const defaultStatus = entry?.defaultStatus ?? null
      if (defaultStatus === null) {
        await tx.carrierStatusMapping.deleteMany({
          where: { id: before.id, storeId, connectionId }
        })
      } else {
        await tx.carrierStatusMapping.updateMany({
          where: { id: before.id, storeId, connectionId },
          data: {
            status: defaultStatus,
            label: entry?.label ?? before.label,
            source: CarrierStatusMappingSource.DEFAULT,
            updatedBy: actor.userId
          }
        })
      }
      return { before, after: defaultStatus }
    })
    this.record(storeId, connectionId, actor, providerCode, outcome.before, outcome.after)
  }

  private async connectionOf(
    storeId: string,
    connectionId: string
  ): Promise<{ id: string; carrierId: string; status: string }> {
    const row = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: { id: true, carrierId: true, status: true }
    })
    if (row === null) throw resourceNotFound('carrier connection')
    return row
  }

  private record(
    storeId: string,
    connectionId: string,
    actor: Actor,
    providerCode: string,
    before: MappingRow | null,
    after: ShipmentStatus | null
  ): void {
    this.audit.log({
      action: AuditAction.CARRIER_STATUS_MAPPING_CHANGED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'carrier_connection',
      resourceId: connectionId,
      // The code and both statuses: names of a closed list and the carrier's own code, nothing of a customer
      metadata: {
        providerCode,
        hadRow: before !== null,
        oldStatus: before?.status ?? null,
        newStatus: after
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
