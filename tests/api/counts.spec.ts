import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AppPaths,
  CountConflicts,
  CountLimits,
  CountResourceTypes,
  CountStatus,
  InventoryAdjustmentReason,
  InventoryReferenceType,
  MembershipStatus,
  InventoryMovementType as Type
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { InventoryService } from '@platform/core/inventory'
import { NotificationTypes } from '@platform/core/notifications'
import { QueueNames } from '@platform/core/queues'

import { createProduct, createWarehouse, linkWarehouse } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface LineBody {
  id: string
  storeId: string
  productId: string
  expectedQuantity: number
  countedQuantity: number | null
  variance: number | null
}
interface CountBody {
  id: string
  number: string
  status: string
  storeId: string | null
  appliedBy: string | null
  totals?: { lines: number; counted: number; withVariance: number }
  lines?: LineBody[]
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

// Physical counts (TDD_16 §4.6, Step 4.6): the stock is counted against a snapshot of the start, and applying writes the
// VARIANCE, so what was sold while the shelf was being counted stays sold.
describe('Physical counts', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inventory: InventoryService
  const pushQueue = new CapturedQueue()
  // Counts storeA: counts and approves; two people in storeA that hold only one of the two permissions
  let both: Awaited<ReturnType<typeof actorWithPermissions>>
  let counter: Awaited<ReturnType<typeof actorWithPermissions>>
  let approver: Awaited<ReturnType<typeof actorWithPermissions>>
  let approverA2: Awaited<ReturnType<typeof actorWithPermissions>>
  let counterA2: Awaited<ReturnType<typeof actorWithPermissions>>
  let bothB: Awaited<ReturnType<typeof actorWithPermissions>>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS)).useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
    inventory = app.get(InventoryService)
    const member = (
      name: string,
      store: { id: string },
      organizationId: string,
      permissions: Parameters<typeof actorWithPermissions>[2]['permissions']
    ) =>
      actorWithPermissions(owner, app, {
        prefix,
        name,
        organizationId,
        storeId: store.id,
        permissions
      })
    const manage = Permissions.INVENTORY_MANAGE_COUNTS
    const apply = Permissions.INVENTORY_APPLY_COUNTS
    both = await member('countBoth', ctx.storeA, ctx.orgA.id, [manage, apply])
    counter = await member('countCounter', ctx.storeA, ctx.orgA.id, [manage])
    approver = await member('countApprover', ctx.storeA, ctx.orgA.id, [apply])
    counterA2 = await member('countCounterA2', ctx.storeA2, ctx.orgA.id, [manage])
    approverA2 = await member('countApproverA2', ctx.storeA2, ctx.orgA.id, [apply])
    bothB = await member('countBothB', ctx.storeB, ctx.orgB.id, [manage, apply])
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const as = (actor: typeof both, store = ctx.storeA) => api(app, actor, store)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const countOf = (response: { body: unknown }) => response.body as CountBody

  // A warehouse of its own, that stores A and A2 both sell from, so that a count sees only what the test put in it
  async function freshWarehouse(name: string) {
    const warehouse = await createWarehouse(owner, {
      organizationId: ctx.orgA.id,
      name: `${name}-${randomUUID().slice(0, 6)}`
    })
    for (const storeId of [ctx.storeA.id, ctx.storeA2.id]) {
      await linkWarehouse(owner, {
        organizationId: ctx.orgA.id,
        storeId,
        warehouseId: warehouse.id
      })
    }
    return warehouse
  }
  async function stocked(warehouseId: string, quantity: number, storeId = ctx.storeA.id) {
    const product = await createProduct(owner, { storeId })
    await inventory.move({
      storeId,
      productId: product.id,
      warehouseId,
      type: Type.RECEIPT,
      quantity,
      reason: InventoryAdjustmentReason.OPENING_STOCK,
      idempotencyKey: randomUUID()
    })
    return { storeId, productId: product.id, warehouseId }
  }
  const levelOf = async (item: { storeId: string; productId: string; warehouseId: string }) =>
    owner.inventoryLevel.findFirstOrThrow({
      where: {
        storeId: item.storeId,
        productId: item.productId,
        warehouseId: item.warehouseId
      }
    })
  // A sale while the count is open: the units are reserved and then leave
  async function sell(
    item: { storeId: string; productId: string; warehouseId: string },
    n: number
  ) {
    const key = `${prefix}-sale-${randomUUID()}`
    await inventory.reserve({ ...item, quantity: n, idempotencyKey: `${key}:r` })
    await inventory.issue({ ...item, quantity: n, idempotencyKey: `${key}:i` })
  }
  const countMovements = (countId: string) =>
    owner.inventoryMovement.findMany({
      where: { referenceType: InventoryReferenceType.COUNT, referenceId: countId },
      orderBy: { seq: 'asc' }
    })

  async function create(warehouseId: string, actor = both, body: Record<string, unknown> = {}) {
    const response = await as(actor)
      .post(ApiRoutes.counts.create)
      .send({ warehouseId, ...body })
    expect(response.status).toBe(CREATED)
    return countOf(response)
  }
  async function started(warehouseId: string, actor = both, body: Record<string, unknown> = {}) {
    const count = await create(warehouseId, actor, body)
    const response = await as(actor).post(ApiRoutes.counts.start(count.id))
    expect(response.status).toBe(OK)
    return count
  }
  async function linesOf(countId: string, actor = both, store = ctx.storeA) {
    const response = await as(actor, store).get(ApiRoutes.counts.byId(countId))
    expect(response.status).toBe(OK)
    return countOf(response)
  }
  const lineOf = async (countId: string, productId: string) => {
    const detail = await linesOf(countId)
    const line = detail.lines?.find(candidate => candidate.productId === productId)
    if (line === undefined) throw new Error('the line is not in the count')
    return line
  }
  const enter = (
    countId: string,
    lines: { lineId: string; countedQuantity: number | null }[],
    actor = both,
    store = ctx.storeA
  ) => as(actor, store).patch(ApiRoutes.counts.lines(countId)).send({ lines })

  describe('the done-when: a count applied after sales', () => {
    it('writes the variance of the snapshot, never counted minus current, and leaves the sales intact', async () => {
      const warehouse = await freshWarehouse('donewhen')
      const item = await stocked(warehouse.id, 10)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      expect(line).toMatchObject({ expectedQuantity: 10, countedQuantity: null, variance: null })

      // 3 units are sold while the shelf is counted: the level is 7 now, and the snapshot still says 10
      await sell(item, 3)
      expect((await levelOf(item)).onHand).toBe(7)

      expect((await enter(count.id, [{ lineId: line.id, countedQuantity: 9 }])).status).toBe(OK)
      expect((await as(both).post(ApiRoutes.counts.submit(count.id))).status).toBe(OK)
      const applied = await as(both).post(ApiRoutes.counts.apply(count.id))

      expect(applied.status).toBe(OK)
      expect(countOf(applied)).toMatchObject({ status: CountStatus.APPLIED, appliedBy: both.id })
      // 9 counted against 10 expected: one unit is missing. 7 - 1 = 6; "counted minus current" would have said 9 (+2)
      expect((await levelOf(item)).onHand).toBe(6)
      const movements = await countMovements(count.id)
      expect(movements).toHaveLength(1)
      expect(movements[0]).toMatchObject({
        type: Type.COUNT_OUT,
        quantity: 1,
        onHandAfter: 6,
        idempotencyKey: `count:${count.id}:${line.id}`,
        createdBy: both.id
      })
      // The sale stays in the ledger exactly as it was written
      const sold = await owner.inventoryMovement.findMany({
        where: { ...item, type: Type.ISSUE }
      })
      expect(sold).toHaveLength(1)
      expect(sold[0]).toMatchObject({ quantity: 3, onHandAfter: 7 })
    })

    it('adds units when the shelf holds more than the snapshot, again on top of a sale', async () => {
      const warehouse = await freshWarehouse('countin')
      const item = await stocked(warehouse.id, 10)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await sell(item, 4)

      await enter(count.id, [{ lineId: line.id, countedQuantity: 12 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))
      expect((await as(both).post(ApiRoutes.counts.apply(count.id))).status).toBe(OK)

      expect((await levelOf(item)).onHand).toBe(8) // 10 - 4 + 2
      expect((await countMovements(count.id))[0]).toMatchObject({
        type: Type.COUNT_IN,
        quantity: 2
      })
    })

    it('writes nothing for a line with no variance and for a line nobody counted', async () => {
      const warehouse = await freshWarehouse('novariance')
      const same = await stocked(warehouse.id, 5)
      const skipped = await stocked(warehouse.id, 5)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, same.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 5 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))

      const applied = await as(both).post(ApiRoutes.counts.apply(count.id))

      expect(applied.status).toBe(OK)
      expect(await countMovements(count.id)).toHaveLength(0)
      expect((await levelOf(same)).onHand).toBe(5)
      // "not counted" is unknown, not zero
      expect((await levelOf(skipped)).onHand).toBe(5)
    })
  })

  describe('the life of a count', () => {
    it('numbers the sheets, takes the snapshot at the start and keeps it while the stock moves', async () => {
      const warehouse = await freshWarehouse('life')
      const item = await stocked(warehouse.id, 8)
      const first = await create(warehouse.id, both, { note: 'aisle 3' })
      const second = await create(warehouse.id)
      expect(first.number).toMatch(new RegExp(`^${CountLimits.NUMBER_PREFIX}\\d{4}$`))
      expect(Number(second.number.slice(3))).toBe(Number(first.number.slice(3)) + 1)
      expect(first.status).toBe(CountStatus.DRAFT)
      // A draft has no lines yet
      expect((await linesOf(first.id)).totals).toMatchObject({ lines: 0 })

      const response = await as(both).post(ApiRoutes.counts.start(first.id))
      expect(countOf(response).status).toBe(CountStatus.COUNTING)
      await inventory.move({
        ...item,
        type: Type.RECEIPT,
        quantity: 5,
        reason: InventoryAdjustmentReason.FOUND,
        idempotencyKey: randomUUID()
      })

      const detail = await linesOf(first.id)
      expect(detail.totals).toEqual({ lines: 1, counted: 0, withVariance: 0 })
      expect(detail.lines?.[0]).toMatchObject({ expectedQuantity: 8 })
      // The snapshot is frozen in the database too: nobody rewrites it
      await expect(
        owner.stockCountLine.updateMany({
          where: { countId: first.id },
          data: { expectedQuantity: 99 }
        })
      ).rejects.toThrow()
    })

    it('enters quantities, takes one back, and filters the lines still to count or with a variance', async () => {
      const warehouse = await freshWarehouse('filters')
      const one = await stocked(warehouse.id, 4)
      const two = await stocked(warehouse.id, 4)
      const count = await started(warehouse.id)
      const lineOne = await lineOf(count.id, one.productId)
      const lineTwo = await lineOf(count.id, two.productId)

      await enter(count.id, [
        { lineId: lineOne.id, countedQuantity: 3 },
        { lineId: lineTwo.id, countedQuantity: 4 }
      ])
      let detail = await linesOf(count.id)
      expect(detail.totals).toEqual({ lines: 2, counted: 2, withVariance: 1 })
      const withVariance = await as(both).get(`${ApiRoutes.counts.byId(count.id)}?filter=variance`)
      expect((withVariance.body as CountBody).lines?.map(line => line.id)).toEqual([lineOne.id])

      await enter(count.id, [{ lineId: lineOne.id, countedQuantity: null }])
      detail = await linesOf(count.id)
      expect(detail.totals).toEqual({ lines: 2, counted: 1, withVariance: 0 })
      const uncounted = await as(both).get(`${ApiRoutes.counts.byId(count.id)}?filter=uncounted`)
      expect((uncounted.body as CountBody).lines?.map(line => line.id)).toEqual([lineOne.id])
    })

    it('refuses what the state does not allow: apply before review, quantities after submit, a second apply', async () => {
      const warehouse = await freshWarehouse('states')
      const item = await stocked(warehouse.id, 4)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)

      const early = await as(both).post(ApiRoutes.counts.apply(count.id))
      expect(early.status).toBe(CONFLICT)
      expect(errorOf(early).code).toBe(ErrorCodes.INVENTORY_COUNT_INVALID_STATUS_TRANSITION)
      expect((await as(both).post(ApiRoutes.counts.start(count.id))).status).toBe(CONFLICT)

      await enter(count.id, [{ lineId: line.id, countedQuantity: 3 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))
      expect((await enter(count.id, [{ lineId: line.id, countedQuantity: 1 }])).status).toBe(
        CONFLICT
      )
      expect((await as(both).post(ApiRoutes.counts.apply(count.id))).status).toBe(OK)

      const again = await as(both).post(ApiRoutes.counts.apply(count.id))
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).code).toBe(ErrorCodes.INVENTORY_COUNT_INVALID_STATUS_TRANSITION)
      expect((await as(both).post(ApiRoutes.counts.cancel(count.id))).status).toBe(CONFLICT)
      expect((await as(both).post(ApiRoutes.counts.reopen(count.id))).status).toBe(CONFLICT)
      expect((await levelOf(item)).onHand).toBe(3)
      expect(await countMovements(count.id)).toHaveLength(1)
    })

    it('cancels a count in any open state and writes nothing', async () => {
      const warehouse = await freshWarehouse('cancel')
      const item = await stocked(warehouse.id, 4)
      const draft = await create(warehouse.id)
      expect(countOf(await as(both).post(ApiRoutes.counts.cancel(draft.id))).status).toBe(
        CountStatus.CANCELLED
      )
      const counting = await started(warehouse.id)
      expect(countOf(await as(both).post(ApiRoutes.counts.cancel(counting.id))).status).toBe(
        CountStatus.CANCELLED
      )
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 0 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))

      const response = await as(both).post(ApiRoutes.counts.cancel(count.id))

      expect(countOf(response).status).toBe(CountStatus.CANCELLED)
      expect(await countMovements(count.id)).toHaveLength(0)
      expect((await levelOf(item)).onHand).toBe(4)
      expect((await enter(count.id, [{ lineId: line.id, countedQuantity: 1 }])).status).toBe(
        CONFLICT
      )
    })

    it('refuses a warehouse with nothing to count, a switched-off one, one that does not exist, and a bad body', async () => {
      const empty = await freshWarehouse('empty')
      const none = await create(empty.id)
      const noLines = await as(both).post(ApiRoutes.counts.start(none.id))
      expect(noLines.status).toBe(CONFLICT)
      expect(errorOf(noLines).metadata).toMatchObject({ conflict: CountConflicts.NO_LINES })

      const off = await freshWarehouse('off')
      await stocked(off.id, 2)
      const sheet = await create(off.id)
      await owner.warehouse.update({ where: { id: off.id }, data: { active: false } })
      const inactive = await as(both).post(ApiRoutes.counts.start(sheet.id))
      expect(inactive.status).toBe(CONFLICT)
      expect(errorOf(inactive).metadata).toMatchObject({
        conflict: CountConflicts.WAREHOUSE_INACTIVE
      })
      const refused = await as(both).post(ApiRoutes.counts.create).send({ warehouseId: off.id })
      expect(refused.status).toBe(CONFLICT)

      expect(
        (await as(both).post(ApiRoutes.counts.create).send({ warehouseId: randomUUID() })).status
      ).toBe(NOT_FOUND)
      expect((await as(both).post(ApiRoutes.counts.create).send({})).status).toBe(BAD_REQUEST)
      expect(
        (await as(both).post(ApiRoutes.counts.create).send({ warehouseId: empty.id, extra: true }))
          .status
      ).toBe(BAD_REQUEST)
    })

    it('limits a count to one store, and refuses a store the caller does not belong to', async () => {
      const warehouse = await freshWarehouse('limited')
      const mine = await stocked(warehouse.id, 3, ctx.storeA.id)
      await stocked(warehouse.id, 3, ctx.storeA2.id)
      const count = await started(warehouse.id, both, { storeId: ctx.storeA.id })
      const detail = await linesOf(count.id)
      expect(detail.storeId).toBe(ctx.storeA.id)
      expect(detail.lines?.map(line => line.productId)).toEqual([mine.productId])
      expect(
        (
          await as(both)
            .post(ApiRoutes.counts.create)
            .send({ warehouseId: warehouse.id, storeId: ctx.storeA2.id })
        ).status
      ).toBe(NOT_FOUND)
      expect(
        (
          await as(both)
            .post(ApiRoutes.counts.create)
            .send({ warehouseId: warehouse.id, storeId: ctx.storeB.id })
        ).status
      ).toBe(NOT_FOUND)
    })
  })

  describe('applying when the stock cannot cover the variance', () => {
    it('refuses the whole count with every short line, writes nothing, and applies after a recount', async () => {
      const warehouse = await freshWarehouse('short')
      const short = await stocked(warehouse.id, 5)
      const fine = await stocked(warehouse.id, 5)
      const count = await started(warehouse.id)
      const shortLine = await lineOf(count.id, short.productId)
      const fineLine = await lineOf(count.id, fine.productId)
      // The shelf is found empty, but two units were sold meanwhile: the stock left is 3, and 5 cannot leave
      await sell(short, 2)
      await enter(count.id, [
        { lineId: shortLine.id, countedQuantity: 0 },
        { lineId: fineLine.id, countedQuantity: 4 }
      ])
      await as(both).post(ApiRoutes.counts.submit(count.id))

      const refused = await as(both).post(ApiRoutes.counts.apply(count.id))

      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).code).toBe(ErrorCodes.INSUFFICIENT_INVENTORY)
      expect(errorOf(refused).metadata).toMatchObject({
        conflict: CountConflicts.SHORT_STOCK,
        lines: [{ lineId: shortLine.id, requested: 5, onHand: 3 }]
      })
      // Nothing was kept, not even the line that could have been applied
      expect(await countMovements(count.id)).toHaveLength(0)
      expect((await levelOf(fine)).onHand).toBe(5)
      expect((await levelOf(short)).onHand).toBe(3)
      expect((await linesOf(count.id)).status).toBe(CountStatus.REVIEW)

      // The approver sends it back, the line is recounted, and it applies
      expect((await as(approver).post(ApiRoutes.counts.reopen(count.id))).status).toBe(OK)
      expect(countOf(await as(both).get(ApiRoutes.counts.byId(count.id))).status).toBe(
        CountStatus.COUNTING
      )
      await enter(count.id, [{ lineId: shortLine.id, countedQuantity: 2 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))
      expect((await as(both).post(ApiRoutes.counts.apply(count.id))).status).toBe(OK)
      expect((await levelOf(short)).onHand).toBe(0)
      expect((await levelOf(fine)).onHand).toBe(4)
      expect(await countMovements(count.id)).toHaveLength(2)
    })

    it('records what the shelf really holds even under reservations: the reservation is not touched', async () => {
      const warehouse = await freshWarehouse('reserved')
      const item = await stocked(warehouse.id, 5)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await inventory.reserve({
        ...item,
        quantity: 4,
        idempotencyKey: `${prefix}-hold-${randomUUID()}`
      })
      await enter(count.id, [{ lineId: line.id, countedQuantity: 2 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))

      const applied = await as(both).post(ApiRoutes.counts.apply(count.id))

      // The units are gone from the shelf whatever was promised: the level says so, and the promise stays to be solved
      expect(applied.status).toBe(OK)
      expect(await levelOf(item)).toMatchObject({ onHand: 2, reserved: 4 })
    })

    it('applies once when two approvers apply at the same time', async () => {
      const warehouse = await freshWarehouse('parallel')
      const item = await stocked(warehouse.id, 6)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 4 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))

      const results = await Promise.all([
        as(both).post(ApiRoutes.counts.apply(count.id)),
        as(both).post(ApiRoutes.counts.apply(count.id))
      ])

      expect(results.map(result => result.status).sort()).toEqual([OK, CONFLICT])
      expect((await levelOf(item)).onHand).toBe(4)
      expect(await countMovements(count.id)).toHaveLength(1)
    })
  })

  describe('the size of a count', () => {
    it('pages the lines with a variance by what matches, not by what was read', async () => {
      const warehouse = await freshWarehouse('variancepages')
      const items = []
      for (let index = 0; index < 6; index += 1) items.push(await stocked(warehouse.id, 5))
      const count = await started(warehouse.id)
      const detail = await linesOf(count.id)
      // Only the last two lines, in the order of the pages (by id), differ from the snapshot
      const ordered = [...(detail.lines ?? [])].sort((a, b) => a.id.localeCompare(b.id))
      await enter(
        count.id,
        ordered.map((line, index) => ({
          lineId: line.id,
          countedQuantity: index >= 4 ? 4 : 5
        }))
      )
      expect(ordered).toHaveLength(6)

      const first = await as(both).get(`${ApiRoutes.counts.byId(count.id)}?filter=variance&limit=1`)
      const second = await as(both).get(
        `${ApiRoutes.counts.byId(count.id)}?filter=variance&limit=1&cursor=${(first.body as { nextCursor: string }).nextCursor}`
      )

      expect((first.body as CountBody & { hasMore: boolean }).lines).toHaveLength(1)
      expect((first.body as { hasMore: boolean }).hasMore).toBe(true)
      expect((second.body as CountBody).lines).toHaveLength(1)
      expect((second.body as { hasMore: boolean }).hasMore).toBe(false)
      expect((first.body as CountBody).lines?.[0]?.id).toBe(ordered[4]?.id)
      expect((second.body as CountBody).lines?.[0]?.id).toBe(ordered[5]?.id)
    })

    it('applies a few hundred variances inside the transaction of the api', async () => {
      const warehouse = await freshWarehouse('big')
      const ids = Array.from({ length: 300 }, () => randomUUID())
      await owner.product.createMany({
        data: ids.map(id => ({
          id,
          storeId: ctx.storeA.id,
          name: `bulk-${id.slice(0, 8)}`,
          priceCents: 100
        }))
      })
      await owner.inventoryLevel.createMany({
        data: ids.map(productId => ({
          storeId: ctx.storeA.id,
          productId,
          warehouseId: warehouse.id,
          onHand: 5
        }))
      })
      const count = await started(warehouse.id)
      const all: LineBody[] = []
      let cursor = ''
      for (;;) {
        const page = await as(both).get(
          `${ApiRoutes.counts.byId(count.id)}?limit=100${cursor === '' ? '' : `&cursor=${cursor}`}`
        )
        all.push(...((page.body as CountBody).lines ?? []))
        const next = (page.body as { nextCursor: string | null }).nextCursor
        if (next === null) break
        cursor = next
      }
      expect(all).toHaveLength(300)
      for (let from = 0; from < all.length; from += 100) {
        const slice = all.slice(from, from + 100)
        const entered = await enter(
          count.id,
          slice.map(line => ({ lineId: line.id, countedQuantity: 3 }))
        )
        expect(entered.status).toBe(OK)
      }
      await as(both).post(ApiRoutes.counts.submit(count.id))

      // One transaction of the api has 15 s: the apply either finishes inside it or answers an error, and the limit of a
      // count (CountLimits.MAX_LINES) is what keeps it there
      const applied = await as(both).post(ApiRoutes.counts.apply(count.id))

      expect(applied.status).toBe(OK)
      expect(await countMovements(count.id)).toHaveLength(300)
    })

    it('refuses to start a count of more items than a count holds, and keeps it a draft', async () => {
      const warehouse = await freshWarehouse('toomany')
      const total = CountLimits.MAX_LINES + 1
      const ids = Array.from({ length: total }, () => randomUUID())
      await owner.product.createMany({
        data: ids.map(id => ({
          id,
          storeId: ctx.storeA.id,
          name: `bulk-${id.slice(0, 8)}`,
          priceCents: 100
        }))
      })
      await owner.inventoryLevel.createMany({
        data: ids.map(productId => ({
          storeId: ctx.storeA.id,
          productId,
          warehouseId: warehouse.id,
          onHand: 1
        }))
      })
      const count = await create(warehouse.id)

      const refused = await as(both).post(ApiRoutes.counts.start(count.id))

      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).metadata).toMatchObject({ conflict: CountConflicts.TOO_MANY_LINES })
      expect((await linesOf(count.id)).status).toBe(CountStatus.DRAFT)
      expect(await owner.stockCountLine.count({ where: { countId: count.id } })).toBe(0)
    })
  })

  describe('applying lines the engine refuses for another reason than the stock', () => {
    it('names every refused line with its code and writes nothing', async () => {
      const warehouse = await freshWarehouse('refused')
      const item = await stocked(warehouse.id, 5)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 8 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))
      // The warehouse is switched off after the start: units cannot come in
      await owner.warehouse.update({ where: { id: warehouse.id }, data: { active: false } })

      const refused = await as(both).post(ApiRoutes.counts.apply(count.id))

      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).code).toBe(ErrorCodes.INVENTORY_COUNT_LINES_REFUSED)
      expect(errorOf(refused).metadata).toMatchObject({
        conflict: CountConflicts.LINES_REFUSED,
        lines: [{ lineId: line.id }]
      })
      expect((await levelOf(item)).onHand).toBe(5)
      expect((await linesOf(count.id)).status).toBe(CountStatus.REVIEW)
    })
  })

  describe('the stores of a count', () => {
    it('shows each person only the lines of the stores they belong to, and counts those only', async () => {
      const warehouse = await freshWarehouse('visibility')
      const inA = await stocked(warehouse.id, 3, ctx.storeA.id)
      const inA2 = await stocked(warehouse.id, 3, ctx.storeA2.id)
      const count = await started(warehouse.id)

      const seenInA = await linesOf(count.id, counter, ctx.storeA)
      expect(seenInA.lines?.map(line => line.productId)).toEqual([inA.productId])
      expect(seenInA.totals).toMatchObject({ lines: 1 })
      const seenInA2 = await linesOf(count.id, counterA2, ctx.storeA2)
      expect(seenInA2.lines?.map(line => line.productId)).toEqual([inA2.productId])

      // A line of the other store does not exist for the caller: all or none, and nothing changed
      const foreignLine = seenInA2.lines?.[0]?.id ?? ''
      const own = seenInA.lines?.[0]?.id ?? ''
      const refused = await enter(
        count.id,
        [
          { lineId: own, countedQuantity: 1 },
          { lineId: foreignLine, countedQuantity: 1 }
        ],
        counter
      )
      expect(refused.status).toBe(NOT_FOUND)
      expect((await lineOf(count.id, inA.productId)).countedQuantity).toBeNull()
      expect((await enter(count.id, [{ lineId: own, countedQuantity: 1 }], counter)).status).toBe(
        OK
      )
      // Someone who may count in A cannot count the line of A2 just by being in the organization
      const other = await enter(count.id, [{ lineId: foreignLine, countedQuantity: 1 }], counter)
      expect(other.status).toBe(NOT_FOUND)
    })

    it('refuses to apply a variance in a store where the approver may not apply, and applies for the one who may', async () => {
      const warehouse = await freshWarehouse('foreign')
      const inA = await stocked(warehouse.id, 5, ctx.storeA.id)
      const inA2 = await stocked(warehouse.id, 5, ctx.storeA2.id)
      const count = await started(warehouse.id)
      const lineA = await lineOf(count.id, inA.productId)
      const lineA2 = (await linesOf(count.id, counterA2, ctx.storeA2)).lines?.[0]?.id ?? ''
      await enter(count.id, [{ lineId: lineA.id, countedQuantity: 4 }], counter)
      await enter(count.id, [{ lineId: lineA2, countedQuantity: 3 }], counterA2, ctx.storeA2)
      await as(counter).post(ApiRoutes.counts.submit(count.id))

      const refused = await as(approver).post(ApiRoutes.counts.apply(count.id))

      expect(refused.status).toBe(FORBIDDEN)
      expect(errorOf(refused).code).toBe(ErrorCodes.INVENTORY_COUNT_STORES_NOT_ALLOWED)
      expect((await levelOf(inA)).onHand).toBe(5)
      expect((await levelOf(inA2)).onHand).toBe(5)
      expect((await linesOf(count.id)).status).toBe(CountStatus.REVIEW)

      // Approvers of both stores, one after the other: the one of A2 is refused for A, so a person who holds the
      // permission in both stores is needed
      expect(
        (await as(approverA2, ctx.storeA2).post(ApiRoutes.counts.apply(count.id))).status
      ).toBe(FORBIDDEN)
      await owner.membership.create({
        data: {
          userId: approver.id,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          roleId: (await owner.membership.findFirstOrThrow({ where: { userId: approverA2.id } }))
            .roleId,
          status: MembershipStatus.ACTIVE
        }
      })
      const applied = await as(approver).post(ApiRoutes.counts.apply(count.id))
      expect(applied.status).toBe(OK)
      expect((await levelOf(inA)).onHand).toBe(4)
      expect((await levelOf(inA2)).onHand).toBe(3)
    })
  })

  describe('permissions and tenants', () => {
    it('needs the permission of each action: counting is not applying, and the approver may read and send back', async () => {
      const warehouse = await freshWarehouse('perms')
      const item = await stocked(warehouse.id, 3)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 2 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))

      // counter: counts, cannot apply
      expect((await as(counter).post(ApiRoutes.counts.apply(count.id))).status).toBe(FORBIDDEN)
      // approver: reads, reopens or cancels, cannot create, start, count or submit
      expect((await as(approver).get(ApiRoutes.counts.list)).status).toBe(OK)
      expect((await as(approver).get(ApiRoutes.counts.byId(count.id))).status).toBe(OK)
      expect(
        (await as(approver).post(ApiRoutes.counts.create).send({ warehouseId: warehouse.id }))
          .status
      ).toBe(FORBIDDEN)
      expect((await as(approver).post(ApiRoutes.counts.start(count.id))).status).toBe(FORBIDDEN)
      expect((await as(approver).post(ApiRoutes.counts.submit(count.id))).status).toBe(FORBIDDEN)
      expect(
        (
          await as(approver)
            .patch(ApiRoutes.counts.lines(count.id))
            .send({ lines: [{ lineId: line.id, countedQuantity: 1 }] })
        ).status
      ).toBe(FORBIDDEN)
      // The roles that hold neither permission
      for (const actor of [ctx.viewerA, ctx.agentA]) {
        expect((await as(actor).get(ApiRoutes.counts.list)).status).toBe(FORBIDDEN)
        expect((await as(actor).get(ApiRoutes.counts.byId(count.id))).status).toBe(FORBIDDEN)
        expect((await as(actor).post(ApiRoutes.counts.apply(count.id))).status).toBe(FORBIDDEN)
      }
      for (const actor of [ctx.viewerA, ctx.agentA]) {
        expect((await as(actor).post(ApiRoutes.counts.reopen(count.id))).status).toBe(FORBIDDEN)
        expect((await as(actor).post(ApiRoutes.counts.cancel(count.id))).status).toBe(FORBIDDEN)
      }
      // The one who counts may send it back, and the approver too
      expect((await as(counter).post(ApiRoutes.counts.reopen(count.id))).status).toBe(OK)
      await as(counter).post(ApiRoutes.counts.submit(count.id))
      expect((await as(approver).post(ApiRoutes.counts.reopen(count.id))).status).toBe(OK)
      expect((await as(approver).post(ApiRoutes.counts.cancel(count.id))).status).toBe(OK)
      expect((await levelOf(item)).onHand).toBe(3)
    })

    it('treats a count of another organization as one that does not exist, on every route', async () => {
      const warehouse = await freshWarehouse('tenant')
      const item = await stocked(warehouse.id, 3)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      const stranger = api(app, bothB, ctx.storeB)

      expect((await stranger.get(ApiRoutes.counts.byId(count.id))).status).toBe(NOT_FOUND)
      expect((await stranger.post(ApiRoutes.counts.start(count.id))).status).toBe(NOT_FOUND)
      expect(
        (
          await stranger
            .patch(ApiRoutes.counts.lines(count.id))
            .send({ lines: [{ lineId: line.id, countedQuantity: 1 }] })
        ).status
      ).toBe(NOT_FOUND)
      expect((await stranger.post(ApiRoutes.counts.submit(count.id))).status).toBe(NOT_FOUND)
      expect((await stranger.post(ApiRoutes.counts.reopen(count.id))).status).toBe(NOT_FOUND)
      expect((await stranger.post(ApiRoutes.counts.apply(count.id))).status).toBe(NOT_FOUND)
      expect((await stranger.post(ApiRoutes.counts.cancel(count.id))).status).toBe(NOT_FOUND)
      expect(
        (await stranger.post(ApiRoutes.counts.create).send({ warehouseId: warehouse.id })).status
      ).toBe(NOT_FOUND)
      const listed = await stranger.get(ApiRoutes.counts.list)
      expect((listed.body as { data: { id: string }[] }).data.map(row => row.id)).not.toContain(
        count.id
      )
      // The header of the other organization was not touched
      expect((await linesOf(count.id)).status).toBe(CountStatus.COUNTING)
    })

    it('lists the sheets of the organization, the newest first, by status and warehouse', async () => {
      const warehouse = await freshWarehouse('list')
      const older = await create(warehouse.id)
      const newer = await create(warehouse.id)
      await as(both).post(ApiRoutes.counts.cancel(older.id))

      const all = await as(both).get(`${ApiRoutes.counts.list}?warehouseId=${warehouse.id}`)
      expect((all.body as { data: { id: string }[] }).data.map(row => row.id)).toEqual([
        newer.id,
        older.id
      ])
      const page = await as(both).get(
        `${ApiRoutes.counts.list}?warehouseId=${warehouse.id}&status=${CountStatus.CANCELLED}&limit=1`
      )
      expect((page.body as { data: { id: string }[] }).data.map(row => row.id)).toEqual([older.id])
    })
  })

  describe('the rules of the database', () => {
    const refused = (work: Promise<unknown>, rule: RegExp) => expect(work).rejects.toThrow(rule)

    it('keeps the lines of a count that is not open: nothing is added or counted after the count is in review, applied or cancelled', async () => {
      const warehouse = await freshWarehouse('frozenlines')
      const item = await stocked(warehouse.id, 4)
      const other = await stocked(warehouse.id, 4)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 3 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))

      await refused(
        owner.stockCountLine.update({ where: { id: line.id }, data: { countedQuantity: 1 } }),
        /written only while the count is open/
      )
      await as(both).post(ApiRoutes.counts.apply(count.id))
      await refused(
        owner.stockCountLine.create({
          data: {
            countId: count.id,
            storeId: other.storeId,
            productId: other.productId,
            expectedQuantity: 4
          }
        }),
        /written only while the count is open/
      )
      expect((await lineOf(count.id, item.productId)).countedQuantity).toBe(3)
    })

    it('never changes the organization, the warehouse or the store of a count', async () => {
      const warehouse = await freshWarehouse('scope')
      await stocked(warehouse.id, 2)
      const count = await create(warehouse.id)

      await refused(
        owner.stockCount.update({ where: { id: count.id }, data: { storeId: ctx.storeA.id } }),
        /never changed/
      )
      await refused(
        owner.stockCount.update({
          where: { id: count.id },
          data: { warehouseId: ctx.warehouseA.id }
        }),
        /never changed/
      )
    })

    it('asks the moments a status implies, and both or none of the applied marker', async () => {
      const warehouse = await freshWarehouse('moments')
      await stocked(warehouse.id, 2)
      const count = await create(warehouse.id)

      await refused(
        owner.stockCount.update({
          where: { id: count.id },
          data: { status: CountStatus.COUNTING }
        }),
        /chk_stock_counts_started/
      )
      await refused(
        owner.stockCount.update({
          where: { id: count.id },
          data: { appliedAt: new Date() }
        }),
        /chk_stock_counts_applied/
      )
      await refused(
        owner.stockCount.update({
          where: { id: count.id },
          data: { status: CountStatus.REVIEW, startedAt: new Date() }
        }),
        /chk_stock_counts_submitted/
      )
    })
  })

  describe('the trail', () => {
    it('writes an audit entry for each step of a count', async () => {
      const warehouse = await freshWarehouse('audit')
      const item = await stocked(warehouse.id, 3)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 2 }])
      await as(both).post(ApiRoutes.counts.submit(count.id))
      await as(both).post(ApiRoutes.counts.reopen(count.id))
      await as(both).post(ApiRoutes.counts.submit(count.id))
      await as(both).post(ApiRoutes.counts.apply(count.id))

      const entries = await waitForAuditEntries(
        owner,
        {
          resourceId: count.id,
          resourceType: { in: [CountResourceTypes.COUNT, CountResourceTypes.COUNT_LINES] }
        },
        7
      )

      expect(entries.map(entry => entry.action).sort()).toEqual(
        [
          AuditAction.COUNT_CREATED,
          AuditAction.COUNT_STARTED,
          AuditAction.COUNT_LINES_UPDATED,
          AuditAction.COUNT_SUBMITTED,
          AuditAction.COUNT_REOPENED,
          AuditAction.COUNT_SUBMITTED,
          AuditAction.COUNT_APPLIED
        ].sort()
      )
      const appliedEntry = entries.find(entry => entry.action === AuditAction.COUNT_APPLIED)
      expect(appliedEntry).toMatchObject({
        userId: both.id,
        organizationId: ctx.orgA.id,
        metadata: { lines: 1, unitsIn: 0, unitsOut: 1 }
      })
    })
  })

  describe('the notification count.awaiting_apply', () => {
    it('tells the approvers of the organization once when a count goes to review, and nobody else', async () => {
      const warehouse = await freshWarehouse('notify')
      const item = await stocked(warehouse.id, 3)
      const count = await started(warehouse.id)
      const line = await lineOf(count.id, item.productId)
      await enter(count.id, [{ lineId: line.id, countedQuantity: 2 }])

      await as(counter).post(ApiRoutes.counts.submit(count.id))

      const told = async () =>
        owner.notification.findMany({
          where: { type: NotificationTypes.COUNT_AWAITING_APPLY, resourceId: count.id }
        })
      const expected = [approver.id, approverA2.id, both.id]
      // The listener tells store by store, after the commit: wait for the people that must be told, not for a number
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const present = (await told()).map(row => row.userId)
        if (expected.every(id => present.includes(id))) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      // Then a quiet window, so that a second line for the same person would be seen
      await new Promise(resolve => setTimeout(resolve, 500))
      const rows = await told()
      const who = rows.map(row => row.userId)
      expect(who).toContain(approver.id)
      expect(who).toContain(approverA2.id)
      expect(who).toContain(both.id)
      expect(who).not.toContain(counter.id)
      expect(who).not.toContain(bothB.id)
      expect(new Set(who).size).toBe(who.length)
      const row = rows.find(candidate => candidate.userId === approver.id)
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        resourceType: CountResourceTypes.COUNT,
        actionPath: AppPaths.org.counts,
        params: { number: count.number }
      })
      expect(rows.find(candidate => candidate.userId === approverA2.id)?.storeId).toBe(
        ctx.storeA2.id
      )
    })
  })
})
