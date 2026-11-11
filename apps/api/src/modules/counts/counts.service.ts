import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  CountConflicts,
  CountLimits,
  CountLineFilters,
  CountResourceTypes,
  CountStatus
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import { countNumber } from './counts.rules'
import type {
  CountLinesQuery,
  CreateCountBody,
  ListCountsQuery,
  UpdateCountLinesBody
} from './counts.schemas'
import {
  assertCounting,
  assertTransition,
  invalidTransition,
  lockCount,
  lockCountNumbers,
  storesOf
} from './counts.support'
import {
  COUNT_LINE_SELECT,
  COUNT_SELECT,
  type CountDetailView,
  countLineView,
  type CountPage,
  type CountView,
  countView
} from './counts.views'

// The physical counts of the organization of the request (TDD_16 §4.6). `organizationId` comes from TenantGuard and is the
// only one read here: never from the body or the query string (CLAUDE.md rule 2). The header of a count belongs to the
// organization; its lines to the store of their product, and a person sees and enters only those of the stores they
// belong to. Applying the count is `CountsApplyService`.
@Injectable()
export class CountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  async list(organizationId: string, query: ListCountsQuery): Promise<CountPage> {
    const { cursor } = query
    const rows = await this.prisma.client.stockCount.findMany({
      where: {
        organizationId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: COUNT_SELECT,
      take: query.limit + 1,
      // The newest first: the sheet somebody just opened is the one they look for
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    const names = await this.storeNames(
      organizationId,
      page.map(row => row.storeId)
    )
    return {
      data: page.map(row =>
        countView(row, row.storeId === null ? null : (names.get(row.storeId) ?? null))
      ),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(
    organizationId: string,
    userId: string,
    countId: string,
    query: CountLinesQuery
  ): Promise<CountDetailView> {
    const row = await this.prisma.client.stockCount.findFirst({
      where: { id: countId, organizationId },
      select: COUNT_SELECT
    })
    if (row === null) throw resourceNotFound('count')
    // Only the lines of the stores the caller belongs to
    const visible = await storesOf(this.prisma.client, organizationId, userId)
    const base = { countId, storeId: { in: visible } }
    const [lines, lineCount, counted, withVariance, names] = await Promise.all([
      this.linePage(countId, visible, query),
      this.prisma.client.stockCountLine.count({ where: base }),
      this.prisma.client.stockCountLine.count({
        where: { ...base, countedQuantity: { not: null } }
      }),
      this.countVariances(countId, visible),
      this.storeNames(organizationId, [row.storeId])
    ])
    const hasMore = lines.length > query.limit
    const page = hasMore ? lines.slice(0, query.limit) : lines
    return {
      ...countView(row, row.storeId === null ? null : (names.get(row.storeId) ?? null)),
      totals: { lines: lineCount, counted, withVariance },
      lines: page.map(countLineView),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      hasMore
    }
  }

  // One page of lines (a page holds `limit + 1` rows so the caller knows whether there are more), ordered by id. The
  // variance filter compares two columns, which Prisma cannot say: the ids come from SQL so that a page counts only the
  // lines that match, then the rows are read.
  private async linePage(countId: string, visible: readonly string[], query: CountLinesQuery) {
    const take = query.limit + 1
    if (query.filter === CountLineFilters.VARIANCE) {
      if (visible.length === 0) return []
      const ids = await this.prisma.client.$queryRaw<{ id: string }[]>`
        SELECT id FROM stock_count_lines
        WHERE count_id = ${countId} AND store_id = ANY(${[...visible]}::text[])
          AND counted_quantity IS NOT NULL AND counted_quantity <> expected_quantity
          AND id > ${query.cursor ?? ''}
        ORDER BY id LIMIT ${take}`
      return this.prisma.client.stockCountLine.findMany({
        where: { id: { in: ids.map(row => row.id) } },
        select: COUNT_LINE_SELECT,
        orderBy: { id: 'asc' }
      })
    }
    return this.prisma.client.stockCountLine.findMany({
      where: {
        countId,
        storeId: { in: [...visible] },
        ...(query.cursor === undefined ? {} : { id: { gt: query.cursor } }),
        ...(query.filter === CountLineFilters.UNCOUNTED ? { countedQuantity: null } : {})
      },
      select: COUNT_LINE_SELECT,
      orderBy: { id: 'asc' },
      take
    })
  }

  private async countVariances(countId: string, storeIds: readonly string[]): Promise<number> {
    if (storeIds.length === 0) return 0
    const rows = await this.prisma.client.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM stock_count_lines
      WHERE count_id = ${countId} AND store_id = ANY(${[...storeIds]}::text[])
        AND counted_quantity IS NOT NULL AND counted_quantity <> expected_quantity`
    return Number(rows[0]?.n ?? 0n)
  }

  private async storeNames(
    organizationId: string,
    storeIds: readonly (string | null)[]
  ): Promise<Map<string, string>> {
    const ids = [...new Set(storeIds.filter((id): id is string => id !== null))]
    if (ids.length === 0) return new Map()
    const rows = await this.prisma.client.store.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true, name: true }
    })
    return new Map(rows.map(row => [row.id, row.name]))
  }

  async create(organizationId: string, body: CreateCountBody, actor: Actor): Promise<CountView> {
    const id = await this.prisma.transaction(async tx => {
      // The store of the request exists while the count is written (a delete of it waits for this)
      await lockStoreForWrite(tx, actor.storeId)
      const warehouse = await tx.warehouse.findFirst({
        where: { id: body.warehouseId, organizationId },
        select: { active: true }
      })
      if (warehouse === null) throw resourceNotFound('warehouse')
      if (!warehouse.active) {
        throw resourceConflict('the warehouse is switched off', {
          conflict: CountConflicts.WAREHOUSE_INACTIVE
        })
      }
      // A count limited to a store names a store where the caller may count: another store, or one of another
      // organization, is a store that does not exist
      if (body.storeId !== undefined) {
        const mine = await storesOf(
          tx,
          organizationId,
          actor.userId,
          Permissions.INVENTORY_MANAGE_COUNTS
        )
        if (!mine.includes(body.storeId)) throw resourceNotFound('store')
      }
      await lockCountNumbers(tx, organizationId)
      const latest = await tx.$queryRaw<{ latest: bigint }[]>`
        SELECT COALESCE(MAX(substring(number FROM ${CountLimits.NUMBER_PREFIX.length + 1}::int)::bigint), 0) AS latest
        FROM stock_counts WHERE organization_id = ${organizationId}`
      const created = await tx.stockCount.create({
        data: {
          organizationId,
          warehouseId: body.warehouseId,
          number: countNumber(Number(latest[0]?.latest ?? 0n) + 1),
          storeId: body.storeId ?? null,
          note: body.note ?? null,
          createdBy: actor.userId
        },
        select: { id: true, number: true }
      })
      return created
    })
    this.audit.log({
      action: AuditAction.COUNT_CREATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: CountResourceTypes.COUNT,
      resourceId: id.id,
      metadata: {
        number: id.number,
        warehouseId: body.warehouseId,
        limitedToStore: body.storeId ?? null
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.header(organizationId, id.id)
  }

  // Draft → counting: the lines are made from the levels of the warehouse, and the on-hand of each is the snapshot the
  // count will be measured against. One statement reads the levels and writes the lines, so the snapshot is of one instant.
  async start(organizationId: string, countId: string, actor: Actor): Promise<CountView> {
    const lines = await this.prisma.transaction(async tx => {
      const count = await lockCount(tx, organizationId, countId)
      assertTransition(count.status, CountStatus.COUNTING)
      const warehouse = await tx.warehouse.findFirst({
        where: { id: count.warehouseId, organizationId },
        select: { active: true }
      })
      if (warehouse === null) throw resourceNotFound('warehouse')
      if (!warehouse.active) {
        throw resourceConflict('the warehouse is switched off', {
          conflict: CountConflicts.WAREHOUSE_INACTIVE
        })
      }
      const found = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM inventory_levels l
        WHERE l.warehouse_id = ${count.warehouseId}
          AND (${count.storeId}::text IS NULL OR l.store_id = ${count.storeId}::text)`
      const total = Number(found[0]?.n ?? 0n)
      if (total === 0) {
        throw resourceConflict('the warehouse has nothing to count', {
          conflict: CountConflicts.NO_LINES
        })
      }
      if (total > CountLimits.MAX_LINES) {
        throw resourceConflict('the warehouse has more items than a count holds', {
          conflict: CountConflicts.TOO_MANY_LINES,
          limit: CountLimits.MAX_LINES
        })
      }
      const inserted = await tx.$executeRaw`
        INSERT INTO stock_count_lines (id, count_id, store_id, product_id, variant_id, expected_quantity)
        SELECT gen_random_uuid()::text, ${countId}, l.store_id, l.product_id, l.variant_id, l.on_hand
        FROM inventory_levels l
        WHERE l.warehouse_id = ${count.warehouseId}
          AND (${count.storeId}::text IS NULL OR l.store_id = ${count.storeId}::text)`
      // The rows written are the snapshot: a level made between the count above and the insert is not in the sheet, and the
      // sheet is checked against its limits as it is (a throw takes the lines back)
      if (inserted === 0) {
        throw resourceConflict('the warehouse has nothing to count', {
          conflict: CountConflicts.NO_LINES
        })
      }
      if (inserted > CountLimits.MAX_LINES) {
        throw resourceConflict('the warehouse has more items than a count holds', {
          conflict: CountConflicts.TOO_MANY_LINES,
          limit: CountLimits.MAX_LINES
        })
      }
      await tx.stockCount.update({
        where: { id: countId },
        data: { status: CountStatus.COUNTING, startedAt: new Date() }
      })
      return inserted
    })
    this.audit.log({
      action: AuditAction.COUNT_STARTED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: CountResourceTypes.COUNT,
      resourceId: countId,
      metadata: { lines },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.header(organizationId, countId)
  }

  // The quantities staff counted, for the lines of the stores they belong to and may count in. All or none: a line
  // that is not theirs (or does not exist) refuses the whole request as not found.
  async updateLines(
    organizationId: string,
    countId: string,
    body: UpdateCountLinesBody,
    actor: Actor
  ): Promise<CountView> {
    await this.prisma.transaction(async tx => {
      const count = await lockCount(tx, organizationId, countId)
      assertCounting(count)
      const mine = await storesOf(
        tx,
        organizationId,
        actor.userId,
        Permissions.INVENTORY_MANAGE_COUNTS
      )
      const owned = await tx.stockCountLine.findMany({
        where: { countId, id: { in: body.lines.map(line => line.lineId) }, storeId: { in: mine } },
        select: { id: true }
      })
      if (owned.length !== body.lines.length) throw resourceNotFound('count_line')
      // One statement for every row, so that the count stays locked for one round trip and not for one per line
      await tx.$executeRaw`
        UPDATE stock_count_lines AS l SET counted_quantity = v.quantity
        FROM unnest(${body.lines.map(line => line.lineId)}::text[], ${body.lines.map(line => line.countedQuantity)}::int[])
          AS v(id, quantity)
        WHERE l.id = v.id AND l.count_id = ${countId}`
    })
    this.audit.log({
      action: AuditAction.COUNT_LINES_UPDATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: CountResourceTypes.COUNT_LINES,
      resourceId: countId,
      metadata: { lines: body.lines.length },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.header(organizationId, countId)
  }

  async submit(organizationId: string, countId: string, actor: Actor): Promise<CountView> {
    const number = await this.prisma.transaction(async tx => {
      const count = await lockCount(tx, organizationId, countId)
      assertTransition(count.status, CountStatus.REVIEW)
      await tx.stockCount.update({
        where: { id: countId },
        data: { status: CountStatus.REVIEW, submittedAt: new Date() }
      })
      // Told after the commit: the approvers are found then, with the permissions they hold then
      this.events.publish(tx, Events.COUNT_SUBMITTED, {
        organizationId,
        storeId: actor.storeId,
        countId,
        number: count.number
      })
      return count.number
    })
    this.audit.log({
      action: AuditAction.COUNT_SUBMITTED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: CountResourceTypes.COUNT,
      resourceId: countId,
      metadata: { number },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.header(organizationId, countId)
  }

  // The approver sends a count in review back to counting, to recount lines
  async reopen(organizationId: string, countId: string, actor: Actor): Promise<CountView> {
    await this.prisma.transaction(async tx => {
      const count = await lockCount(tx, organizationId, countId)
      // draft → counting is `start`, which makes the lines: it is not a way to reopen
      if (count.status !== CountStatus.REVIEW) {
        throw invalidTransition(count.status, CountStatus.COUNTING)
      }
      await tx.stockCount.update({
        where: { id: countId },
        data: { status: CountStatus.COUNTING, submittedAt: null }
      })
    })
    this.audit.log({
      action: AuditAction.COUNT_REOPENED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: CountResourceTypes.COUNT,
      resourceId: countId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.header(organizationId, countId)
  }

  async cancel(organizationId: string, countId: string, actor: Actor): Promise<CountView> {
    const from = await this.prisma.transaction(async tx => {
      const count = await lockCount(tx, organizationId, countId)
      assertTransition(count.status, CountStatus.CANCELLED)
      await tx.stockCount.update({
        where: { id: countId },
        data: { status: CountStatus.CANCELLED }
      })
      return count.status
    })
    this.audit.log({
      action: AuditAction.COUNT_CANCELLED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: CountResourceTypes.COUNT,
      resourceId: countId,
      metadata: { from },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.header(organizationId, countId)
  }

  async header(organizationId: string, countId: string): Promise<CountView> {
    const row = await this.prisma.client.stockCount.findFirst({
      where: { id: countId, organizationId },
      select: COUNT_SELECT
    })
    if (row === null) throw resourceNotFound('count')
    const names = await this.storeNames(organizationId, [row.storeId])
    return countView(row, row.storeId === null ? null : (names.get(row.storeId) ?? null))
  }
}
