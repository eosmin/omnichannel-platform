import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  InventoryAdjustmentReason,
  InventoryConflicts,
  InventoryMovementType as Type
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { InventoryService, type MovementInput } from '@platform/core/inventory'

import { createProduct, createProductVariant, createWarehouse, linkWarehouse } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The engine of stock (TDD_16 §4, §9), through the real service on the real database: the movements of an order are
// not routes yet (Step 4.3), so this is how they are proven.
describe('InventoryService', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inventory: InventoryService
  let emitter: EventEmitter2
  let prisma: PrismaService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    inventory = app.get(InventoryService, { strict: false })
    emitter = app.get(EventEmitter2, { strict: false })
    prisma = app.get(PrismaService, { strict: false })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const key = (): string => `${prefix}-${randomUUID()}`
  async function item(
    options: { onHand?: number; unitCostCents?: number; threshold?: number } = {}
  ) {
    const product = await createProduct(owner, { storeId: ctx.storeA.id })
    if (options.threshold !== undefined) {
      await owner.product.update({
        where: { id: product.id },
        data: { lowStockThreshold: options.threshold }
      })
    }
    const base = {
      storeId: ctx.storeA.id,
      productId: product.id,
      warehouseId: ctx.warehouseA.id
    }
    if (options.onHand !== undefined && options.onHand > 0) {
      await inventory.move({
        ...base,
        type: Type.RECEIPT,
        quantity: options.onHand,
        reason: InventoryAdjustmentReason.OPENING_STOCK,
        unitCostCents: options.unitCostCents ?? null,
        idempotencyKey: key()
      })
    }
    return {
      ...base,
      move: (input: Partial<MovementInput> & Pick<MovementInput, 'type' | 'quantity'>) =>
        inventory.move({ ...base, idempotencyKey: key(), ...input })
    }
  }
  const levelOf = (productId: string, warehouseId = ctx.warehouseA.id) =>
    owner.inventoryLevel.findFirstOrThrow({ where: { productId, warehouseId, variantId: null } })
  const setNegativeStock = (allow: boolean) =>
    owner.storeSettings.update({
      where: { storeId: ctx.storeA.id },
      data: { allowNegativeStock: allow }
    })
  const refusal = (promise: Promise<unknown>, code: string) =>
    expect(promise).rejects.toMatchObject({ code })

  describe('a movement', () => {
    it('changes the level and writes the ledger together, with what is on hand after it', async () => {
      const stock = await item({ onHand: 10 })

      const reserved = await stock.move({ type: Type.RESERVE, quantity: 4 })
      await stock.move({
        type: Type.ADJUSTMENT_OUT,
        quantity: 2,
        reason: InventoryAdjustmentReason.LOST
      })

      expect(reserved.replayed).toBe(false)
      expect(reserved.movement).toMatchObject({
        onHandAfter: 10,
        reservedAfter: 4,
        type: Type.RESERVE
      })
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 8, reserved: 4 })
      const ledger = await owner.inventoryMovement.findMany({
        where: { productId: stock.productId },
        orderBy: { createdAt: 'asc' }
      })
      expect(ledger.map(row => [row.type, row.onHandAfter, row.reservedAfter])).toEqual([
        [Type.RECEIPT, 10, 0],
        [Type.RESERVE, 10, 4],
        [Type.ADJUSTMENT_OUT, 8, 4]
      ])
    })

    it('follows the life of an order: reserve, issue when it ships, release when it is cancelled, restock on a return', async () => {
      const shipped = await item({ onHand: 10 })
      await shipped.move({ type: Type.RESERVE, quantity: 3 })
      await shipped.move({ type: Type.ISSUE, quantity: 3 })
      expect(await levelOf(shipped.productId)).toMatchObject({ onHand: 7, reserved: 0 })
      await inventory.restock({
        storeId: ctx.storeA.id,
        productId: shipped.productId,
        warehouseId: ctx.warehouseA.id,
        quantity: 1,
        idempotencyKey: key()
      })
      expect(await levelOf(shipped.productId)).toMatchObject({ onHand: 8, reserved: 0 })

      const cancelled = await item({ onHand: 5 })
      await cancelled.move({ type: Type.RESERVE, quantity: 5 })
      await cancelled.move({ type: Type.RELEASE, quantity: 5 })
      expect(await levelOf(cancelled.productId)).toMatchObject({ onHand: 5, reserved: 0 })
    })

    it('keeps a level per variant of a product, apart from the product row itself', async () => {
      const stock = await item()
      const variant = await createProductVariant(owner, { productId: stock.productId })

      await stock.move({ type: Type.RECEIPT, quantity: 4, reason: InventoryAdjustmentReason.FOUND })
      await stock.move({
        type: Type.RECEIPT,
        quantity: 6,
        variantId: variant.id,
        reason: InventoryAdjustmentReason.FOUND
      })

      const levels = await owner.inventoryLevel.findMany({ where: { productId: stock.productId } })
      expect(levels.map(level => [level.variantId, level.onHand]).sort()).toEqual(
        [
          [null, 4],
          [variant.id, 6]
        ].sort()
      )
    })

    it('refuses what does not exist or does not belong: another store, a variant of another product, a warehouse of another organization', async () => {
      const stock = await item({ onHand: 1 })
      const other = await createProduct(owner, { storeId: ctx.storeA.id })
      const foreignVariant = await createProductVariant(owner, { productId: other.id })
      const foreignProduct = await createProduct(owner, { storeId: ctx.storeB.id })

      await refusal(
        stock.move({ type: Type.RESERVE, quantity: 1, variantId: foreignVariant.id }),
        ErrorCodes.RESOURCE_NOT_FOUND
      )
      await refusal(
        inventory.reserve({
          storeId: ctx.storeA.id,
          productId: foreignProduct.id,
          warehouseId: ctx.warehouseA.id,
          quantity: 1,
          idempotencyKey: key()
        }),
        ErrorCodes.RESOURCE_NOT_FOUND
      )
      await refusal(
        stock.move({ type: Type.RESERVE, quantity: 1, warehouseId: ctx.warehouseB.id }),
        ErrorCodes.RESOURCE_NOT_FOUND
      )
      expect(await owner.inventoryMovement.count({ where: { productId: foreignProduct.id } })).toBe(
        0
      )
    })

    it('refuses a product that does not track inventory', async () => {
      const stock = await item()
      await owner.product.update({
        where: { id: stock.productId },
        data: { trackInventory: false }
      })

      await refusal(
        stock.move({ type: Type.RECEIPT, quantity: 1, reason: InventoryAdjustmentReason.FOUND }),
        ErrorCodes.INVENTORY_PRODUCT_NOT_TRACKED
      )
      expect(await owner.inventoryLevel.count({ where: { productId: stock.productId } })).toBe(0)
    })

    it.each([
      ['a quantity of zero', { quantity: 0 }],
      ['a negative quantity', { quantity: -1 }],
      ['a fraction', { quantity: 1.5 }],
      ['more than a movement may move', { quantity: 1_000_001 }],
      ['an empty key', { idempotencyKey: '  ' }],
      [
        'a cost on a movement that takes units out',
        { type: Type.ADJUSTMENT_OUT, unitCostCents: 5 }
      ],
      ['a negative cost', { type: Type.RECEIPT, unitCostCents: -1 }],
      ['a fractional cost', { type: Type.RECEIPT, unitCostCents: 1.5 }]
    ])('answers 400 for %s, and writes nothing', async (_label, change) => {
      const stock = await item({ onHand: 5 })
      const before = await owner.inventoryMovement.count({ where: { productId: stock.productId } })

      await refusal(
        stock.move({
          type: Type.RECEIPT,
          quantity: 1,
          reason: InventoryAdjustmentReason.FOUND,
          ...change
        }),
        ErrorCodes.VALIDATION_FAILED
      )

      expect(await owner.inventoryMovement.count({ where: { productId: stock.productId } })).toBe(
        before
      )
    })

    it('asks a reason of a manual adjustment, and a reason or a note of a receipt', async () => {
      const stock = await item({ onHand: 5 })

      for (const type of [Type.ADJUSTMENT_IN, Type.ADJUSTMENT_OUT]) {
        await refusal(
          stock.move({ type, quantity: 1 }),
          ErrorCodes.INVENTORY_ADJUSTMENT_REASON_REQUIRED
        )
      }
      await refusal(
        stock.move({ type: Type.RECEIPT, quantity: 1 }),
        ErrorCodes.INVENTORY_ADJUSTMENT_REASON_REQUIRED
      )
      await stock.move({ type: Type.RECEIPT, quantity: 1, note: 'delivery of the supplier' })
      await stock.move({
        type: Type.RECEIPT,
        quantity: 1,
        reason: InventoryAdjustmentReason.OPENING_STOCK
      })
      expect((await levelOf(stock.productId)).onHand).toBe(7)
    })
  })

  describe('a warehouse', () => {
    it('must be linked to the store and on to take stock or a reservation, but not to give it up', async () => {
      const unlinked = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      const stock = await item({ onHand: 3 })
      const into = (warehouseId: string, type: Type) =>
        inventory.move({
          storeId: ctx.storeA.id,
          productId: stock.productId,
          warehouseId,
          type,
          quantity: 1,
          reason: InventoryAdjustmentReason.FOUND,
          idempotencyKey: key()
        })

      await refusal(into(unlinked.id, Type.RECEIPT), ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED)
      await refusal(into(unlinked.id, Type.RESERVE), ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED)

      // Stock left in a warehouse the store was unlinked from can still be written off
      const link = await linkWarehouse(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        warehouseId: unlinked.id
      })
      await into(unlinked.id, Type.RECEIPT)
      await owner.storeWarehouse.delete({ where: { id: link.id } })
      await into(unlinked.id, Type.ADJUSTMENT_OUT)
      await refusal(into(unlinked.id, Type.RECEIPT), ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED)

      // A warehouse that is switched off takes nothing new
      await owner.warehouse.update({
        where: { id: ctx.warehouseASecond.id },
        data: { active: false }
      })
      await refusal(
        into(ctx.warehouseASecond.id, Type.RECEIPT),
        ErrorCodes.INVENTORY_WAREHOUSE_INACTIVE
      )
      await owner.warehouse.update({
        where: { id: ctx.warehouseASecond.id },
        data: { active: true }
      })
    })
  })

  describe('the idempotency key', () => {
    it('applies a retried movement once and answers the original', async () => {
      const stock = await item({ onHand: 5 })
      const idempotencyKey = key()
      const input = { type: Type.RESERVE, quantity: 2, idempotencyKey }

      const first = await stock.move(input)
      const again = await stock.move(input)

      expect(again.replayed).toBe(true)
      expect(again.movement.id).toBe(first.movement.id)
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 5, reserved: 2 })
      expect(
        await owner.inventoryMovement.count({
          where: { productId: stock.productId, type: Type.RESERVE }
        })
      ).toBe(1)
    })

    it('answers a retry with the original even when the stock has changed since, and when it would be refused now', async () => {
      const stock = await item({ onHand: 2 })
      const input = { type: Type.RESERVE, quantity: 2, idempotencyKey: key() }
      await stock.move(input)

      // Now nothing is available: the same request would be refused, but it was applied: it is answered
      const again = await stock.move(input)

      expect(again.replayed).toBe(true)
      expect(again.movement.reservedAfter).toBe(2)
    })

    it('is a conflict when the same key comes with another request', async () => {
      const stock = await item({ onHand: 5 })
      const idempotencyKey = key()
      await stock.move({ type: Type.RESERVE, quantity: 1, idempotencyKey })

      for (const change of [{ quantity: 2 }, { type: Type.RELEASE }]) {
        await expect(
          stock.move({ type: Type.RESERVE, quantity: 1, idempotencyKey, ...change })
        ).rejects.toMatchObject({
          code: ErrorCodes.RESOURCE_CONFLICT,
          metadata: { conflict: InventoryConflicts.IDEMPOTENCY_KEY_REUSED }
        })
      }
      expect(await levelOf(stock.productId)).toMatchObject({ reserved: 1 })
    })

    it('applies once when the same request arrives many times at the same moment', async () => {
      const stock = await item({ onHand: 100 })

      // Several rounds, each with a key of its own: a race that is lost only now and then is found
      for (let round = 0; round < 4; round += 1) {
        const idempotencyKey = key()
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            stock.move({ type: Type.RESERVE, quantity: 3, idempotencyKey })
          )
        )

        expect(results.filter(result => !result.replayed)).toHaveLength(1)
        expect(new Set(results.map(result => result.movement.id)).size).toBe(1)
      }

      expect(await levelOf(stock.productId)).toMatchObject({ reserved: 12 })
    })
  })

  describe('the last unit', () => {
    it('goes to exactly one of two parallel reservations', async () => {
      const stock = await item({ onHand: 1 })

      const results = await Promise.allSettled([
        stock.move({ type: Type.RESERVE, quantity: 1 }),
        stock.move({ type: Type.RESERVE, quantity: 1 })
      ])

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const failed = results.find(result => result.status === 'rejected')
      expect(failed).toMatchObject({
        reason: { code: ErrorCodes.INSUFFICIENT_INVENTORY, metadata: { available: 0 } }
      })
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 1, reserved: 1 })
    })

    it('never goes negative under a crowd, and a level made at the same moment is one level', async () => {
      const stock = await item()
      // Ten receipts of the first units of an item that has no level yet, all at once
      await Promise.all(
        Array.from({ length: 10 }, () =>
          stock.move({ type: Type.RECEIPT, quantity: 1, reason: InventoryAdjustmentReason.FOUND })
        )
      )
      expect(await owner.inventoryLevel.count({ where: { productId: stock.productId } })).toBe(1)
      expect((await levelOf(stock.productId)).onHand).toBe(10)

      // Thirty customers for ten units
      const sales = await Promise.allSettled(
        Array.from({ length: 30 }, () => stock.move({ type: Type.RESERVE, quantity: 1 }))
      )

      expect(sales.filter(result => result.status === 'fulfilled')).toHaveLength(10)
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 10, reserved: 10 })
    })

    it('lets two orders that touch the same items in opposite orders both finish', async () => {
      const a = await item({ onHand: 5 })
      const b = await createProduct(owner, { storeId: ctx.storeA.id })
      await inventory.move({
        storeId: ctx.storeA.id,
        productId: b.id,
        warehouseId: ctx.warehouseA.id,
        type: Type.RECEIPT,
        quantity: 5,
        reason: InventoryAdjustmentReason.FOUND,
        idempotencyKey: key()
      })
      const reserve = (productId: string) => ({
        storeId: ctx.storeA.id,
        productId,
        warehouseId: ctx.warehouseA.id,
        type: Type.RESERVE,
        quantity: 1,
        idempotencyKey: key()
      })

      // Six orders for five units of each item: none waits on another for ever, and exactly five get through
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          inventory.moveMany(
            index % 2 === 0
              ? [reserve(a.productId), reserve(b.id)]
              : [reserve(b.id), reserve(a.productId)]
          )
        )
      )

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5)
      expect(results.find(result => result.status === 'rejected')).toMatchObject({
        reason: { code: ErrorCodes.INSUFFICIENT_INVENTORY }
      })
      expect((await levelOf(a.productId)).reserved).toBe(5)
      expect((await levelOf(b.id)).reserved).toBe(5)
    })
  })

  describe('negative stock', () => {
    afterEach(() => setNegativeStock(false))

    it('is never reached while the store does not allow it, and the answer says what is available', async () => {
      const stock = await item({ onHand: 3 })
      await stock.move({ type: Type.RESERVE, quantity: 2 })

      await expect(stock.move({ type: Type.RESERVE, quantity: 2 })).rejects.toMatchObject({
        code: ErrorCodes.INSUFFICIENT_INVENTORY,
        metadata: { available: 1, requested: 2, warehouseId: ctx.warehouseA.id }
      })
      await expect(
        stock.move({
          type: Type.ADJUSTMENT_OUT,
          quantity: 4,
          reason: InventoryAdjustmentReason.LOST
        })
      ).rejects.toMatchObject({ code: ErrorCodes.INSUFFICIENT_INVENTORY, metadata: { onHand: 3 } })
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 3, reserved: 2 })
    })

    it('lets orders pass the stock and the stock go below zero when the store allows it, but never a transfer out', async () => {
      await setNegativeStock(true)
      const stock = await item({ onHand: 2 })

      await stock.move({ type: Type.RESERVE, quantity: 5 })
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 2, reserved: 5 })
      await stock.move({ type: Type.ISSUE, quantity: 5 })
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: -3, reserved: 0 })
      await stock.move({
        type: Type.ADJUSTMENT_OUT,
        quantity: 1,
        reason: InventoryAdjustmentReason.LOST
      })
      expect((await levelOf(stock.productId)).onHand).toBe(-4)

      // A transfer out needs real, available stock, whatever the setting says
      const real = await item({ onHand: 3 })
      await real.move({ type: Type.RESERVE, quantity: 2 })
      await refusal(
        real.move({ type: Type.TRANSFER_OUT, quantity: 2 }),
        ErrorCodes.INSUFFICIENT_INVENTORY
      )
      await real.move({ type: Type.TRANSFER_OUT, quantity: 1 })
    })

    it('leaves the data alone when the setting is turned off, and refuses what would lower it further', async () => {
      await setNegativeStock(true)
      const stock = await item({ onHand: 1 })
      await stock.move({
        type: Type.ADJUSTMENT_OUT,
        quantity: 4,
        reason: InventoryAdjustmentReason.LOST
      })
      await setNegativeStock(false)

      expect((await levelOf(stock.productId)).onHand).toBe(-3)
      await refusal(
        stock.move({
          type: Type.ADJUSTMENT_OUT,
          quantity: 1,
          reason: InventoryAdjustmentReason.LOST
        }),
        ErrorCodes.INSUFFICIENT_INVENTORY
      )
      await refusal(
        stock.move({ type: Type.RESERVE, quantity: 1 }),
        ErrorCodes.INSUFFICIENT_INVENTORY
      )
      // Receipts bring it back
      await stock.move({ type: Type.RECEIPT, quantity: 5, reason: InventoryAdjustmentReason.FOUND })
      expect((await levelOf(stock.productId)).onHand).toBe(2)
    })

    it('refuses to release or issue more than is reserved, even when negative stock is allowed', async () => {
      await setNegativeStock(true)
      const stock = await item({ onHand: 5 })
      await stock.move({ type: Type.RESERVE, quantity: 2 })

      await refusal(
        stock.move({ type: Type.RELEASE, quantity: 3 }),
        ErrorCodes.INVENTORY_RESERVATION_EXCEEDED
      )
      await refusal(
        stock.move({ type: Type.ISSUE, quantity: 3 }),
        ErrorCodes.INVENTORY_RESERVATION_EXCEEDED
      )
    })
  })

  describe('the cost of the units', () => {
    it('keeps the weighted average: entries fix the cost, exits take the average and record it', async () => {
      const stock = await item({ onHand: 10, unitCostCents: 200 })
      await stock.move({
        type: Type.RECEIPT,
        quantity: 10,
        unitCostCents: 300,
        reason: InventoryAdjustmentReason.FOUND
      })
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 20, valueCents: 5000n })

      const out = await stock.move({
        type: Type.ADJUSTMENT_OUT,
        quantity: 4,
        reason: InventoryAdjustmentReason.DAMAGED
      })

      expect(out.movement.unitCostCents).toBe(250)
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 16, valueCents: 4000n })
      const reserve = await stock.move({ type: Type.RESERVE, quantity: 1 })
      expect(reserve.movement.unitCostCents).toBeNull()
      expect((await levelOf(stock.productId)).valueCents).toBe(4000n)
      // The receipts are in the ledger with their cost: lots can be built from them later
      const receipts = await owner.inventoryMovement.findMany({
        where: { productId: stock.productId, type: Type.RECEIPT },
        orderBy: { createdAt: 'asc' }
      })
      expect(receipts.map(row => row.unitCostCents)).toEqual([200, 300])
    })

    it('empties the value with the last unit', async () => {
      const stock = await item({ onHand: 3, unitCostCents: 3 })
      await owner.inventoryLevel.updateMany({
        where: { productId: stock.productId },
        data: { valueCents: 10n }
      })
      for (const quantity of [1, 1, 1]) {
        await stock.move({
          type: Type.ADJUSTMENT_OUT,
          quantity,
          reason: InventoryAdjustmentReason.LOST
        })
      }

      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 0, valueCents: 0n })
    })
  })

  describe('the events', () => {
    function listen<E extends typeof Events.INVENTORY_MOVED | typeof Events.INVENTORY_LOW>(
      event: E
    ) {
      const heard: Record<string, unknown>[] = []
      const handler = (payload: Record<string, unknown>): void => {
        heard.push(payload)
      }
      emitter.on(event, handler)
      return { heard, stop: () => emitter.off(event, handler) }
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 150))

    it('announces a movement after it commits, with the item, the warehouse, the type and the quantity', async () => {
      const moved = listen(Events.INVENTORY_MOVED)
      const stock = await item({ onHand: 4 })
      await stock.move({ type: Type.RESERVE, quantity: 2 })
      await settle()
      moved.stop()

      expect(moved.heard.filter(payload => payload['productId'] === stock.productId)).toEqual([
        expect.objectContaining({ type: Type.RECEIPT, quantity: 4 }),
        {
          storeId: ctx.storeA.id,
          productId: stock.productId,
          variantId: null,
          warehouseId: ctx.warehouseA.id,
          type: Type.RESERVE,
          quantity: 2
        }
      ])
    })

    it('announces nothing for a movement that is rolled back with the transaction of its caller', async () => {
      const moved = listen(Events.INVENTORY_MOVED)
      const stock = await item({ onHand: 4 })
      const rollback = new Error('the order failed')
      await settle()
      const before = moved.heard.length

      await expect(
        prisma.transaction(async tx => {
          await inventory.reserve(
            {
              storeId: ctx.storeA.id,
              productId: stock.productId,
              warehouseId: ctx.warehouseA.id,
              quantity: 2,
              idempotencyKey: key()
            },
            tx
          )
          throw rollback
        })
      ).rejects.toBe(rollback)
      await settle()
      moved.stop()

      expect(moved.heard).toHaveLength(before)
      expect(await levelOf(stock.productId)).toMatchObject({ onHand: 4, reserved: 0 })
    })

    it('commits an order and its reservations together, through the transaction of the caller', async () => {
      const first = await item({ onHand: 2 })
      const second = await item({ onHand: 0 })
      const reserve = (productId: string) => ({
        storeId: ctx.storeA.id,
        productId,
        warehouseId: ctx.warehouseA.id,
        quantity: 1,
        idempotencyKey: key()
      })

      // The second line has no stock: the whole order fails and the first reservation goes with it
      await expect(
        prisma.transaction(async tx => {
          await inventory.reserve(reserve(first.productId), tx)
          await inventory.reserve(reserve(second.productId), tx)
        })
      ).rejects.toMatchObject({ code: ErrorCodes.INSUFFICIENT_INVENTORY })

      expect(await levelOf(first.productId)).toMatchObject({ reserved: 0 })
    })

    it('warns once when the available stock of a product falls to its threshold, and again after it has recovered', async () => {
      const low = listen(Events.INVENTORY_LOW)
      const stock = await item({ onHand: 10, threshold: 3 })
      const mine = () => low.heard.filter(payload => payload['productId'] === stock.productId)

      await stock.move({ type: Type.RESERVE, quantity: 5 }) // 5 available: above
      await stock.move({ type: Type.RESERVE, quantity: 2 }) // 3: at the threshold, it fell
      await settle()
      expect(mine()).toEqual([
        { storeId: ctx.storeA.id, productId: stock.productId, available: 3, threshold: 3 }
      ])

      await stock.move({ type: Type.RESERVE, quantity: 1 }) // 2: already low, no second warning
      await stock.move({
        type: Type.RECEIPT,
        quantity: 20,
        reason: InventoryAdjustmentReason.FOUND
      }) // 22: recovered
      await stock.move({ type: Type.RESERVE, quantity: 20 }) // 2: fell again
      await settle()
      low.stop()

      expect(mine()).toHaveLength(2)
      expect(mine()[1]).toMatchObject({ available: 2 })
    })

    it('does not warn for a product with no threshold, or when stock goes up', async () => {
      const low = listen(Events.INVENTORY_LOW)
      const none = await item({ onHand: 5 })
      const withThreshold = await item({ onHand: 1, threshold: 3 })

      await none.move({ type: Type.RESERVE, quantity: 5 })
      await withThreshold.move({
        type: Type.RECEIPT,
        quantity: 1,
        reason: InventoryAdjustmentReason.FOUND
      })
      await settle()
      low.stop()

      expect(
        low.heard.filter(payload =>
          [none.productId, withThreshold.productId].includes(payload['productId'] as string)
        )
      ).toEqual([])
    })
  })

  describe('the stock of one store', () => {
    it('is never touched by a movement of another store, even with the same key', async () => {
      const mine = await item({ onHand: 3 })
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id })
      const idempotencyKey = key()

      await inventory.move({
        storeId: ctx.storeB.id,
        productId: theirs.id,
        warehouseId: ctx.warehouseB.id,
        type: Type.RECEIPT,
        quantity: 7,
        reason: InventoryAdjustmentReason.FOUND,
        idempotencyKey
      })
      await mine.move({
        type: Type.RECEIPT,
        quantity: 1,
        reason: InventoryAdjustmentReason.FOUND,
        idempotencyKey
      })

      expect((await levelOf(mine.productId)).onHand).toBe(4)
      expect(
        (
          await owner.inventoryLevel.findFirstOrThrow({
            where: { productId: theirs.id, warehouseId: ctx.warehouseB.id }
          })
        ).onHand
      ).toBe(7)
    })
  })
})
