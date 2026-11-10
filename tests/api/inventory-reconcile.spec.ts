import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Counter, Registry } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { InventoryAdjustmentReason, InventoryMovementType as Type } from '@platform/core/domain'
import { InventoryService } from '@platform/core/inventory'
import { MetricNames } from '@platform/core/metrics'
import { JobNames, reconcileInventoryJobId } from '@platform/core/queues'

import { InventoryReconciler } from '../../apps/worker/src/inventory/inventory-reconciler.service'
import { InventoryReconcileScheduler } from '../../apps/worker/src/schedulers/inventory-reconcile.scheduler'
import { createProduct, createProductVariant, createWarehouse, linkWarehouse } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue } from '../helpers/queue'

// The daily check of the stock against its ledger (TDD_16 §4.8, Step 4.2 PR C): it reads, it reports, it never fixes.
// Every case works in a store of its own, so what an earlier case forged is not in the way of the next one.
describe('The reconciliation of the stock', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inventory: InventoryService
  let prisma: PrismaService
  let counter: Counter<string>
  const warnings: { fields: Record<string, unknown>; message: string }[] = []
  const errors: { fields: Record<string, unknown>; message: string }[] = []
  let reconciler: InventoryReconciler

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    inventory = app.get(InventoryService, { strict: false })
    prisma = app.get(PrismaService, { strict: false })
    counter = new Counter({
      name: MetricNames.INVENTORY_RECONCILIATION_MISMATCHES,
      help: 'test',
      labelNames: ['store_id'],
      registers: [new Registry()]
    })
    const logger = {
      setContext: () => undefined,
      info: () => undefined,
      error: (fields: Record<string, unknown>, message: string) => {
        errors.push({ fields, message })
      },
      warn: (fields: Record<string, unknown>, message: string) => {
        warnings.push({ fields, message })
      }
    } as unknown as PinoLogger
    reconciler = new InventoryReconciler(prisma, inventory, counter, logger)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    warnings.length = 0
    errors.length = 0
  })

  const key = (): string => `${prefix}-${randomUUID()}`
  async function aStore() {
    const store = await ensureStore(owner, ctx.orgA.id, `${prefix}-${randomUUID().slice(0, 8)}`)
    const warehouse = await createWarehouse(owner, { organizationId: ctx.orgA.id })
    await linkWarehouse(owner, {
      organizationId: ctx.orgA.id,
      storeId: store.id,
      warehouseId: warehouse.id
    })
    return { storeId: store.id, warehouseId: warehouse.id }
  }
  async function stocked(
    store: { storeId: string; warehouseId: string },
    onHand: number,
    unitCostCents: number | null = 250
  ) {
    const product = await createProduct(owner, { storeId: store.storeId })
    await inventory.move({
      storeId: store.storeId,
      productId: product.id,
      warehouseId: store.warehouseId,
      type: Type.RECEIPT,
      quantity: onHand,
      reason: InventoryAdjustmentReason.OPENING_STOCK,
      unitCostCents,
      idempotencyKey: key()
    })
    return product.id
  }
  const levelOf = (productId: string) =>
    owner.inventoryLevel.findFirstOrThrow({ where: { productId, variantId: null } })
  const mismatches = (storeId: string) =>
    counter.get().then(metric => {
      const row = metric.values.find(value => value.labels['store_id'] === storeId)
      return row?.value ?? 0
    })

  describe('one store', () => {
    it('reports nothing for a store whose levels all agree with the ledger', async () => {
      const store = await aStore()
      const productId = await stocked(store, 10)
      await inventory.move({
        storeId: store.storeId,
        productId,
        warehouseId: store.warehouseId,
        type: Type.RESERVE,
        quantity: 4,
        idempotencyKey: key()
      })

      const report = await reconciler.reconcileStore(store.storeId)

      expect(report).toEqual({ levelsChecked: 1, mismatches: 0, negativeNotAllowed: 0, failed: 0 })
      expect(warnings).toEqual([])
      expect(await mismatches(store.storeId)).toBe(0)
    })

    it.each([
      ['on hand', { onHand: 11 }, 'onHand'],
      ['reserved', { reserved: 3 }, 'reserved'],
      ['value', { valueCents: 999n }, 'valueCents']
    ] as const)(
      'reports a level whose %s was forged, with both values, and never fixes it',
      async (_name, forged, field) => {
        const store = await aStore()
        const productId = await stocked(store, 10)
        const honest = await levelOf(productId)
        await owner.inventoryLevel.update({ where: { id: honest.id }, data: forged })

        const report = await reconciler.reconcileStore(store.storeId)

        expect(report).toMatchObject({ levelsChecked: 1, mismatches: 1 })
        expect(await mismatches(store.storeId)).toBe(1)
        expect(warnings).toHaveLength(1)
        const [warning] = warnings
        expect(warning?.fields).toMatchObject({
          storeId: store.storeId,
          productId,
          warehouseId: store.warehouseId,
          variantId: null,
          mismatch: true
        })
        const actual = (warning?.fields['actual'] ?? {}) as Record<string, unknown>
        const expected = (warning?.fields['expected'] ?? {}) as Record<string, unknown>
        // The log shows numbers as numbers and the value (a BigInt in the database) as a string
        const shown = (value: unknown) => (typeof value === 'bigint' ? value.toString() : value)
        expect(actual[field]).toBe(shown(forged[field as keyof typeof forged]))
        expect(expected[field]).toBe(shown(honest[field]))
        // Read only: the forged number is still there, and no movement was written to explain it
        const after = await levelOf(productId)
        expect(after[field]).toEqual(forged[field as keyof typeof forged])
        expect(await owner.inventoryMovement.count({ where: { productId } })).toBe(1)
      }
    )

    it('reports a level that was deleted while its ledger still has movements', async () => {
      const store = await aStore()
      const productId = await stocked(store, 6)
      await owner.inventoryLevel.delete({ where: { id: (await levelOf(productId)).id } })

      const report = await reconciler.reconcileStore(store.storeId)

      expect(report).toMatchObject({ levelsChecked: 1, mismatches: 1 })
      expect(warnings[0]?.fields).toMatchObject({ productId, mismatch: true })
      expect(await owner.inventoryLevel.count({ where: { productId } })).toBe(0)
    })

    it('checks a level of a variant apart from the one of its product', async () => {
      const store = await aStore()
      const product = await createProduct(owner, { storeId: store.storeId })
      const variant = await createProductVariant(owner, { productId: product.id })
      await inventory.move({
        storeId: store.storeId,
        productId: product.id,
        variantId: variant.id,
        warehouseId: store.warehouseId,
        type: Type.RECEIPT,
        quantity: 3,
        reason: InventoryAdjustmentReason.OPENING_STOCK,
        idempotencyKey: key()
      })
      const level = await owner.inventoryLevel.findFirstOrThrow({
        where: { productId: product.id, variantId: variant.id }
      })
      await owner.inventoryLevel.update({ where: { id: level.id }, data: { onHand: 99 } })

      const report = await reconciler.reconcileStore(store.storeId)

      expect(report).toMatchObject({ mismatches: 1 })
      expect(warnings[0]?.fields).toMatchObject({ variantId: variant.id })
    })

    it('reads a store in pages and still checks every level', async () => {
      const store = await aStore()
      const products = [await stocked(store, 2), await stocked(store, 3), await stocked(store, 4)]
      for (const productId of products.slice(1)) {
        await owner.inventoryLevel.update({
          where: { id: (await levelOf(productId)).id },
          data: { onHand: 50 }
        })
      }

      const report = await reconciler.reconcileStore(store.storeId, { pageSize: 1 })

      expect(report).toEqual({ levelsChecked: 3, mismatches: 2, negativeNotAllowed: 0, failed: 0 })
      expect(warnings.map(warning => warning.fields['productId']).sort()).toEqual(
        products.slice(1).sort()
      )
    })
  })

  describe('a negative level', () => {
    // The ledger agrees with the level: the stock went below zero while the store allowed it
    async function negativeStore(allowAfter: boolean) {
      const store = await aStore()
      await owner.storeSettings.upsert({
        where: { storeId: store.storeId },
        create: { storeId: store.storeId, allowNegativeStock: true },
        update: { allowNegativeStock: true }
      })
      const productId = await stocked(store, 1)
      await inventory.move({
        storeId: store.storeId,
        productId,
        warehouseId: store.warehouseId,
        type: Type.ADJUSTMENT_OUT,
        quantity: 3,
        reason: InventoryAdjustmentReason.LOST,
        idempotencyKey: key()
      })
      await owner.storeSettings.update({
        where: { storeId: store.storeId },
        data: { allowNegativeStock: allowAfter }
      })
      return { store, productId }
    }

    it('is reported apart, with a field of its own, when the store does not allow negative stock', async () => {
      const { store, productId } = await negativeStore(false)

      const report = await reconciler.reconcileStore(store.storeId)

      expect(await levelOf(productId)).toMatchObject({ onHand: -2 })
      // The ledger and the level agree: this is not a mismatch
      expect(report).toEqual({ levelsChecked: 1, mismatches: 0, negativeNotAllowed: 1, failed: 0 })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.fields).toMatchObject({
        productId,
        negativeNotAllowed: true,
        mismatch: false
      })
      expect(await mismatches(store.storeId)).toBe(1)
    })

    it('is not reported while the store allows it', async () => {
      const { store } = await negativeStore(true)

      const report = await reconciler.reconcileStore(store.storeId)

      expect(report).toEqual({ levelsChecked: 1, mismatches: 0, negativeNotAllowed: 0, failed: 0 })
      expect(warnings).toEqual([])
    })

    it('is reported once, with both fields, when it is also forged', async () => {
      const store = await aStore()
      const productId = await stocked(store, 5)
      await owner.inventoryLevel.update({
        where: { id: (await levelOf(productId)).id },
        data: { onHand: -1 }
      })

      const report = await reconciler.reconcileStore(store.storeId)

      expect(report).toEqual({ levelsChecked: 1, mismatches: 1, negativeNotAllowed: 1, failed: 0 })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.fields).toMatchObject({ mismatch: true, negativeNotAllowed: true })
    })
  })

  describe('an item that cannot be read', () => {
    it('is told and counted, and the other levels of the store are still checked', async () => {
      const store = await aStore()
      const first = await stocked(store, 2)
      const second = await stocked(store, 3)
      await owner.inventoryLevel.update({
        where: { id: (await levelOf(second)).id },
        data: { onHand: 90 }
      })
      const real = inventory.checkLevel.bind(inventory)
      const spy = jest.spyOn(inventory, 'checkLevel').mockImplementation(async (item, tx) => {
        if (item.productId === first) throw new Error('lock timeout')
        return real(item, tx)
      })
      try {
        const report = await reconciler.reconcileStore(store.storeId)

        expect(report).toEqual({
          levelsChecked: 1,
          mismatches: 1,
          negativeNotAllowed: 0,
          failed: 1
        })
        expect(errors).toHaveLength(1)
        expect(errors[0]?.fields).toMatchObject({ productId: first })
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('the tenancy of the check', () => {
    it('never reads a level or a ledger of another store, and does not count its forgeries', async () => {
      const clean = await aStore()
      const forged = await aStore()
      await stocked(clean, 4)
      const bad = await stocked(forged, 4)
      await owner.inventoryLevel.update({
        where: { id: (await levelOf(bad)).id },
        data: { onHand: 77 }
      })
      const before = await mismatches(clean.storeId)

      const report = await reconciler.reconcileStore(clean.storeId)

      expect(report).toEqual({ levelsChecked: 1, mismatches: 0, negativeNotAllowed: 0, failed: 0 })
      expect(warnings).toEqual([])
      expect(await mismatches(clean.storeId)).toBe(before)
    })

    it('counts a forgery under the store it belongs to', async () => {
      const forged = await aStore()
      const bad = await stocked(forged, 4)
      await owner.inventoryLevel.update({
        where: { id: (await levelOf(bad)).id },
        data: { reserved: 2 }
      })

      await reconciler.reconcileStore(forged.storeId)

      expect(await mismatches(forged.storeId)).toBe(1)
      expect(await mismatches(ctx.storeB.id)).toBe(0)
    })

    it('answers an empty report for a store that has no stock or does not exist', async () => {
      for (const storeId of [(await aStore()).storeId, randomUUID()]) {
        expect(await reconciler.reconcileStore(storeId)).toEqual({
          levelsChecked: 0,
          mismatches: 0,
          negativeNotAllowed: 0,
          failed: 0
        })
      }
    })
  })

  describe('the daily schedule', () => {
    const NOW = new Date('2026-11-12T04:00:00.000Z')
    const heavy = new CapturedQueue()
    const locks = {
      withLock: async (_name: string, _seconds: number, work: () => Promise<void>) => {
        await work()
        return true
      }
    } as never // the lock is not what is tested here
    const logger = { setContext: () => undefined, error: () => undefined } as unknown as PinoLogger
    let scheduler: InventoryReconcileScheduler

    beforeAll(() => {
      scheduler = new InventoryReconcileScheduler(locks, heavy as never, prisma, logger)
    })
    beforeEach(() => {
      heavy.jobs.length = 0
    })

    it('queues one job for each store that has stock, with an id of its own for the day', async () => {
      const withStock = await aStore()
      await stocked(withStock, 2)
      const empty = await aStore()

      await scheduler.enqueueAll(NOW)

      const mine = heavy.jobs.filter(
        job => (job.data as { storeId: string }).storeId === withStock.storeId
      )
      expect(mine).toEqual([
        {
          name: JobNames.RECONCILE_INVENTORY,
          data: { storeId: withStock.storeId },
          opts: { jobId: reconcileInventoryJobId(withStock.storeId, '2026-11-12') }
        }
      ])
      expect(
        heavy.jobs.some(job => (job.data as { storeId: string }).storeId === empty.storeId)
      ).toBe(false)
    })

    it('asks for the same job ids when it runs twice in a day, and for new ones the next day', async () => {
      const store = await aStore()
      await stocked(store, 2)
      const idsOf = () =>
        heavy.jobs
          .filter(job => (job.data as { storeId: string }).storeId === store.storeId)
          .map(job => job.opts?.jobId)

      await scheduler.enqueueAll(NOW)
      await scheduler.enqueueAll(new Date(NOW.getTime() + 3_600_000))
      await scheduler.enqueueAll(new Date(NOW.getTime() + 86_400_000))

      const ids = idsOf()
      expect(ids[0]).toBe(ids[1])
      expect(ids[2]).not.toBe(ids[0])
    })

    it('also queues a store that has a ledger and lost every level, and pages through the stores', async () => {
      const lost = await aStore()
      const productId = await stocked(lost, 2)
      await owner.inventoryLevel.delete({ where: { id: (await levelOf(productId)).id } })
      const kept = await aStore()
      await stocked(kept, 1)

      const queued = await scheduler.enqueueAll(NOW, { pageSize: 1 })

      // The database is shared with the other suites, so this checks that both stores of the case came, not a total
      expect(queued).toBeGreaterThanOrEqual(2)
      for (const store of [lost, kept]) {
        expect(
          heavy.jobs.some(job => (job.data as { storeId: string }).storeId === store.storeId)
        ).toBe(true)
      }
      // Each store once, however many pages it took
      const ids = heavy.jobs.map(job => job.opts?.jobId)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('does not throw when the queue is down: the next day tries again', async () => {
      const broken = {
        addBulk: () => Promise.reject(new Error('redis is down'))
      }
      const failing = new InventoryReconcileScheduler(locks, broken as never, prisma, logger)

      await expect(failing.run()).resolves.toBeUndefined()
    })
  })
})
