import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { InventoryAdjustmentReason, InventoryConflicts } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createProduct, createProductVariant } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface MovementBody {
  id: string
  productId: string
  warehouseId: string
  type: string
  quantity: number
  reason: string | null
  onHandAfter: number
  reservedAfter: number
  unitCostCents?: number | null
}
interface AdjustmentBody {
  movement: MovementBody
  replayed: boolean
}
interface LevelBody {
  id: string
  productId: string
  variantId: string | null
  warehouseId: string
  warehouseCode: string
  onHand: number
  reserved: number
  available: number
  lowStockThreshold: number | null
  valueCents?: number
  averageCostCents?: number | null
}
interface PageBody<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

describe('The stock of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  async function product(options: { threshold?: number } = {}) {
    const made = await createProduct(owner, { storeId: ctx.storeA.id })
    if (options.threshold !== undefined) {
      await owner.product.update({
        where: { id: made.id },
        data: { lowStockThreshold: options.threshold }
      })
    }
    return made
  }
  const adjustment = (productId: string, change: Record<string, unknown> = {}) => ({
    warehouseId: ctx.warehouseA.id,
    productId,
    type: 'receipt',
    quantity: 10,
    reason: InventoryAdjustmentReason.OPENING_STOCK,
    idempotencyKey: randomUUID(),
    ...change
  })
  const post = (body: Record<string, unknown>, agent = asAdmin()) =>
    agent.post(ApiRoutes.inventory.adjustments).send(body)
  async function receive(productId: string, quantity: number, unitCostCents?: number) {
    const response = await post(adjustment(productId, { quantity, unitCostCents }))
    expect(response.status).toBe(CREATED)
    return (response.body as AdjustmentBody).movement
  }

  describe('an adjustment', () => {
    it('receives stock: 201 with the movement, what is on hand after it, and who did it in the audit log', async () => {
      const made = await product()

      const response = await post(adjustment(made.id, { note: 'first delivery' }))

      expect(response.status).toBe(CREATED)
      const body = response.body as AdjustmentBody
      expect(body.replayed).toBe(false)
      expect(body.movement).toMatchObject({
        productId: made.id,
        warehouseId: ctx.warehouseA.id,
        type: 'receipt',
        quantity: 10,
        reason: 'opening_stock',
        onHandAfter: 10,
        reservedAfter: 0
      })
      const level = await owner.inventoryLevel.findFirstOrThrow({ where: { productId: made.id } })
      expect(level).toMatchObject({ onHand: 10, reserved: 0, storeId: ctx.storeA.id })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.INVENTORY_ADJUSTED,
        resourceId: made.id
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ storeId: ctx.storeA.id, userId: ctx.adminA.id })
      expect(entries[0]?.metadata).toMatchObject({ type: 'receipt', quantity: 10 })
    })

    it('applies a retry once: 200, the same movement, and no second audit entry', async () => {
      const made = await product()
      const body = adjustment(made.id)

      const first = await post(body)
      const again = await post(body)

      expect(first.status).toBe(CREATED)
      expect(again.status).toBe(OK)
      const retried = again.body as AdjustmentBody
      expect(retried.replayed).toBe(true)
      expect(retried.movement.id).toBe((first.body as AdjustmentBody).movement.id)
      expect(
        (await owner.inventoryLevel.findFirstOrThrow({ where: { productId: made.id } })).onHand
      ).toBe(10)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.INVENTORY_ADJUSTED,
        resourceId: made.id
      })
      expect(entries).toHaveLength(1)
    })

    it('answers 409 when a key comes back with another request, and changes nothing', async () => {
      const made = await product()
      const body = adjustment(made.id)
      await post(body)

      const response = await post({ ...body, quantity: 99 })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({
        conflict: InventoryConflicts.IDEMPOTENCY_KEY_REUSED
      })
      expect(
        (await owner.inventoryLevel.findFirstOrThrow({ where: { productId: made.id } })).onHand
      ).toBe(10)
    })

    it('takes stock out, and refuses more than there is: 409 with what is on hand', async () => {
      const made = await product()
      await receive(made.id, 5)

      const out = await post(
        adjustment(made.id, { type: 'adjustment_out', quantity: 2, reason: 'damaged' })
      )
      expect((out.body as AdjustmentBody).movement).toMatchObject({ onHandAfter: 3 })

      const tooMuch = await post(
        adjustment(made.id, { type: 'adjustment_out', quantity: 4, reason: 'lost' })
      )
      expect(tooMuch.status).toBe(CONFLICT)
      expect(errorOf(tooMuch)).toMatchObject({
        code: ErrorCodes.INSUFFICIENT_INVENTORY,
        metadata: { onHand: 3, requested: 4 }
      })
      expect(
        (await owner.inventoryLevel.findFirstOrThrow({ where: { productId: made.id } })).onHand
      ).toBe(3)
    })

    it('goes below zero when the store allows negative stock', async () => {
      const store = ctx.storeA
      await owner.storeSettings.update({
        where: { storeId: store.id },
        data: { allowNegativeStock: true }
      })
      try {
        const made = await product()
        await receive(made.id, 1)

        const out = await post(
          adjustment(made.id, { type: 'adjustment_out', quantity: 3, reason: 'lost' })
        )

        expect(out.status).toBe(CREATED)
        expect((out.body as AdjustmentBody).movement.onHandAfter).toBe(-2)
      } finally {
        await owner.storeSettings.update({
          where: { storeId: store.id },
          data: { allowNegativeStock: false }
        })
      }
    })

    it('asks a reason of an adjustment and a reason or a note of a receipt: 400 with the code', async () => {
      const made = await product()

      const adjustmentNoReason = await post(
        adjustment(made.id, { type: 'adjustment_in', reason: undefined })
      )
      const receiptNothing = await post(adjustment(made.id, { reason: undefined }))
      const receiptNote = await post(adjustment(made.id, { reason: undefined, note: 'delivery' }))

      expect(adjustmentNoReason.status).toBe(BAD_REQUEST)
      expect(errorOf(adjustmentNoReason).code).toBe(ErrorCodes.INVENTORY_ADJUSTMENT_REASON_REQUIRED)
      expect(receiptNothing.status).toBe(BAD_REQUEST)
      expect(receiptNote.status).toBe(CREATED)
    })

    it.each([
      ['the store', { storeId: randomUUID() }],
      ['a quantity of zero', { quantity: 0 }],
      ['a fraction', { quantity: 1.5 }],
      ['too many units', { quantity: 1_000_001 }],
      ['a type that is not manual', { type: 'issue' }],
      ['a reason that does not exist', { reason: 'because' }],
      ['a key that is not a uuid', { idempotencyKey: 'again' }],
      ['a negative cost', { unitCostCents: -1 }],
      ['a note with a line break', { note: 'a\nb' }]
    ])('answers 400 for %s', async (_label, change) => {
      const made = await product()

      const response = await post(adjustment(made.id, change))

      expect(response.status).toBe(BAD_REQUEST)
      expect(errorOf(response).code).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await owner.inventoryMovement.count({ where: { productId: made.id } })).toBe(0)
    })

    it('answers 404 for a product, a variant or a warehouse that is not there, and 409 for a product that does not track stock', async () => {
      const made = await product()
      const other = await product()
      const foreignVariant = await createProductVariant(owner, { productId: other.id })
      const untracked = await product()
      await owner.product.update({ where: { id: untracked.id }, data: { trackInventory: false } })

      expect((await post(adjustment(randomUUID()))).status).toBe(NOT_FOUND)
      expect((await post(adjustment(made.id, { warehouseId: randomUUID() }))).status).toBe(
        NOT_FOUND
      )
      expect((await post(adjustment(made.id, { variantId: foreignVariant.id }))).status).toBe(
        NOT_FOUND
      )
      const notTracked = await post(adjustment(untracked.id))
      expect(notTracked.status).toBe(CONFLICT)
      expect(errorOf(notTracked).code).toBe(ErrorCodes.INVENTORY_PRODUCT_NOT_TRACKED)
    })

    it('keeps the cost of the units: the average is what the units leave at', async () => {
      const made = await product()
      await receive(made.id, 10, 200)
      await receive(made.id, 10, 300)

      const out = await post(
        adjustment(made.id, { type: 'adjustment_out', quantity: 4, reason: 'damaged' })
      )

      expect((out.body as AdjustmentBody).movement.unitCostCents).toBe(250)
      const levels = await asAdmin().get(ApiRoutes.inventory.levels).query({ productId: made.id })
      expect((levels.body as PageBody<LevelBody>).data[0]).toMatchObject({
        onHand: 16,
        valueCents: 4000,
        averageCostCents: 250
      })
    })
  })

  describe('permissions and the cost', () => {
    it('lets a viewer read stock and nobody but who holds inventory:adjust change it', async () => {
      const made = await product()
      const viewer = api(app, ctx.viewerA, ctx.storeA)
      const agent = api(app, ctx.agentA, ctx.storeA)

      for (const reader of [viewer, agent]) {
        expect((await reader.get(ApiRoutes.inventory.levels)).status).toBe(OK)
        expect((await reader.get(ApiRoutes.inventory.movements)).status).toBe(OK)
        expect((await reader.get(ApiRoutes.products.inventory(made.id))).status).toBe(OK)
        const attempt = await post(adjustment(made.id), reader)
        expect(attempt.status).toBe(FORBIDDEN)
        expect(errorOf(attempt).code).toBe(ErrorCodes.PERMISSION_DENIED)
      }
      expect(await owner.inventoryMovement.count({ where: { productId: made.id } })).toBe(0)
    })

    it('asks inventory:view to read and nothing else gives it', async () => {
      const adjuster = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'only-adjust',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: [Permissions.INVENTORY_ADJUST, Permissions.PRODUCTS_VIEW_COST]
        }),
        ctx.storeA
      )
      const made = await product()

      expect((await adjuster.get(ApiRoutes.inventory.levels)).status).toBe(FORBIDDEN)
      expect((await adjuster.get(ApiRoutes.inventory.movements)).status).toBe(FORBIDDEN)
      expect(
        (await adjuster.get(ApiRoutes.inventory.kardex).query({ productId: made.id })).status
      ).toBe(FORBIDDEN)
      expect((await adjuster.get(ApiRoutes.products.inventory(made.id))).status).toBe(FORBIDDEN)
      expect((await post(adjustment(made.id), adjuster)).status).toBe(CREATED)
    })

    it('leaves the cost out for who cannot see it, on levels, movements, the kardex and the product, and puts it in for who can', async () => {
      const made = await product()
      await receive(made.id, 10, 200)
      const noCost = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'view-no-cost',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: [Permissions.INVENTORY_VIEW]
        }),
        ctx.storeA
      )

      const kardexQuery = { productId: made.id, warehouseId: ctx.warehouseA.id }
      const hidden = [
        (await noCost.get(ApiRoutes.inventory.levels).query({ productId: made.id }))
          .body as PageBody<Record<string, unknown>>,
        (await noCost.get(ApiRoutes.inventory.movements).query({ productId: made.id }))
          .body as PageBody<Record<string, unknown>>,
        (await noCost.get(ApiRoutes.inventory.kardex).query(kardexQuery)).body as PageBody<
          Record<string, unknown>
        >
      ]
      for (const page of hidden) {
        expect(page.data.length).toBeGreaterThan(0)
        for (const row of page.data) {
          expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['valueCents']))
          for (const key of ['valueCents', 'averageCostCents', 'unitCostCents']) {
            expect(row).not.toHaveProperty(key)
          }
        }
      }
      const productView = (await noCost.get(ApiRoutes.products.inventory(made.id))).body as {
        levels: Record<string, unknown>[]
      }
      expect(productView.levels[0]).not.toHaveProperty('valueCents')

      const shown = (
        await asAdmin().get(ApiRoutes.inventory.movements).query({ productId: made.id })
      ).body as PageBody<MovementBody>
      expect(shown.data[0]?.unitCostCents).toBe(200)
      const adminProduct = (await asAdmin().get(ApiRoutes.products.inventory(made.id))).body as {
        levels: LevelBody[]
      }
      expect(adminProduct.levels[0]).toMatchObject({ valueCents: 2000, averageCostCents: 200 })
    })

    it('refuses to set the cost of the units to who may not see it, and writes nothing', async () => {
      const made = await product()
      const adjusterNoCost = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'adjust-no-cost',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: [Permissions.INVENTORY_ADJUST]
        }),
        ctx.storeA
      )

      const refused = await post(adjustment(made.id, { unitCostCents: 500 }), adjusterNoCost)
      const withoutCost = await post(adjustment(made.id), adjusterNoCost)

      expect(refused.status).toBe(FORBIDDEN)
      expect(errorOf(refused).code).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(withoutCost.status).toBe(CREATED)
      expect((withoutCost.body as AdjustmentBody).movement).not.toHaveProperty('unitCostCents')
      expect(
        await owner.inventoryMovement.count({ where: { productId: made.id, unitCostCents: 500 } })
      ).toBe(0)
    })
  })

  describe('the levels', () => {
    it('lists them newest change first in pages that never repeat a row, with what is available', async () => {
      const made = await product()
      const variant = await createProductVariant(owner, { productId: made.id })
      await receive(made.id, 4)
      await post(adjustment(made.id, { variantId: variant.id, quantity: 6 }))
      await post(adjustment(made.id, { warehouseId: ctx.warehouseASecond.id, quantity: 2 }))

      const seen: LevelBody[] = []
      let cursor: string | null = null
      do {
        const response: { body: unknown } = await asAdmin()
          .get(ApiRoutes.inventory.levels)
          .query({ productId: made.id, limit: 1, ...(cursor === null ? {} : { cursor }) })
        const page = response.body as PageBody<LevelBody>
        seen.push(...page.data)
        cursor = page.nextCursor
      } while (cursor !== null)

      expect(seen).toHaveLength(3)
      expect(new Set(seen.map(level => level.id)).size).toBe(3)
      expect(seen.map(level => level.onHand).sort()).toEqual([2, 4, 6])
      expect(seen.every(level => level.available === level.onHand - level.reserved)).toBe(true)
    })

    it('filters by warehouse, by product and by item', async () => {
      const made = await product()
      const variant = await createProductVariant(owner, { productId: made.id })
      await receive(made.id, 3)
      await post(adjustment(made.id, { variantId: variant.id, quantity: 5 }))
      await post(adjustment(made.id, { warehouseId: ctx.warehouseASecond.id, quantity: 7 }))
      const query = (filter: Record<string, string>) =>
        asAdmin()
          .get(ApiRoutes.inventory.levels)
          .query({ productId: made.id, ...filter })

      const second = (await query({ warehouseId: ctx.warehouseASecond.id }))
        .body as PageBody<LevelBody>
      const byVariant = (await query({ variantId: variant.id })).body as PageBody<LevelBody>

      expect(second.data.map(level => level.onHand)).toEqual([7])
      expect(byVariant.data.map(level => level.onHand)).toEqual([5])
    })

    it('finds the products that are at their threshold or under it, summing their warehouses', async () => {
      const low = await product({ threshold: 5 })
      const fine = await product({ threshold: 5 })
      const noThreshold = await product()
      await receive(low.id, 3)
      await post(adjustment(low.id, { warehouseId: ctx.warehouseASecond.id, quantity: 2 })) // 5: at it
      await receive(fine.id, 3)
      await post(adjustment(fine.id, { warehouseId: ctx.warehouseASecond.id, quantity: 3 })) // 6: above
      await receive(noThreshold.id, 0 + 1)

      const response = await asAdmin()
        .get(ApiRoutes.inventory.levels)
        .query({ lowStock: 'true', limit: 100 })

      const productIds = (response.body as PageBody<LevelBody>).data.map(level => level.productId)
      expect(productIds).toContain(low.id)
      expect(productIds).not.toContain(fine.id)
      expect(productIds).not.toContain(noThreshold.id)
    })

    it('answers the stock of a product with its totals, and 404 for a product that is not of the store', async () => {
      const made = await product({ threshold: 2 })
      await receive(made.id, 8)
      await post(adjustment(made.id, { warehouseId: ctx.warehouseASecond.id, quantity: 4 }))

      const response = await asAdmin().get(ApiRoutes.products.inventory(made.id))

      expect(response.status).toBe(OK)
      const body = response.body as {
        onHand: number
        reserved: number
        available: number
        lowStockThreshold: number
        levels: LevelBody[]
      }
      expect(body).toMatchObject({ onHand: 12, reserved: 0, available: 12, lowStockThreshold: 2 })
      expect(body.levels.map(level => level.warehouseCode)).toHaveLength(2)
      expect((await asAdmin().get(ApiRoutes.products.inventory(randomUUID()))).status).toBe(
        NOT_FOUND
      )
      expect((await asAdmin().get(ApiRoutes.products.inventory('not-a-uuid'))).status).toBe(
        BAD_REQUEST
      )
    })

    it.each([
      ['a limit of zero', { limit: 0 }],
      ['a limit over the maximum', { limit: 101 }],
      ['a cursor that is not one', { cursor: 'nope' }],
      ['a parameter it does not know', { storeId: randomUUID() }],
      ['a warehouse that is not an id', { warehouseId: 'x' }],
      ['lowStock that is not a boolean', { lowStock: 'maybe' }]
    ])('answers 400 for %s', async (_label, query) => {
      const response = await asAdmin().get(ApiRoutes.inventory.levels).query(query)

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('the movements and the kardex', () => {
    it('lists the movements newest first and filters them by type and by product', async () => {
      const made = await product()
      await receive(made.id, 10)
      await post(adjustment(made.id, { type: 'adjustment_out', quantity: 3, reason: 'lost' }))
      await post(adjustment(made.id, { type: 'adjustment_in', quantity: 1, reason: 'found' }))

      const all = (await asAdmin().get(ApiRoutes.inventory.movements).query({ productId: made.id }))
        .body as PageBody<MovementBody>
      const outs = (
        await asAdmin()
          .get(ApiRoutes.inventory.movements)
          .query({ productId: made.id, type: 'adjustment_out' })
      ).body as PageBody<MovementBody>

      expect(all.data.map(row => row.type)).toEqual(['adjustment_in', 'adjustment_out', 'receipt'])
      expect(outs.data.map(row => row.quantity)).toEqual([3])
    })

    it('gives the kardex of an item in a warehouse with the running balance of each movement', async () => {
      const made = await product()
      await receive(made.id, 10)
      await post(adjustment(made.id, { type: 'adjustment_out', quantity: 4, reason: 'lost' }))
      await post(adjustment(made.id, { warehouseId: ctx.warehouseASecond.id, quantity: 99 }))

      const response = await asAdmin()
        .get(ApiRoutes.inventory.kardex)
        .query({ productId: made.id, warehouseId: ctx.warehouseA.id })

      expect(response.status).toBe(OK)
      const rows = (response.body as PageBody<MovementBody>).data
      expect(rows.map(row => [row.type, row.onHandAfter])).toEqual([
        ['adjustment_out', 6],
        ['receipt', 10]
      ])
    })

    it('needs the item and the warehouse, and answers 404 for a product that is not of the store', async () => {
      const made = await product()

      expect(
        (await asAdmin().get(ApiRoutes.inventory.kardex).query({ productId: made.id })).status
      ).toBe(BAD_REQUEST)
      expect((await asAdmin().get(ApiRoutes.inventory.kardex)).status).toBe(BAD_REQUEST)
      expect(
        (
          await asAdmin()
            .get(ApiRoutes.inventory.kardex)
            .query({ productId: randomUUID(), warehouseId: ctx.warehouseA.id })
        ).status
      ).toBe(NOT_FOUND)
    })
  })
})
