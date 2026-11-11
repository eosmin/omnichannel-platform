import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AppPaths,
  InventoryAdjustmentReason,
  MembershipStatus,
  InventoryMovementType as Type
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { InventoryService } from '@platform/core/inventory'
import { NotificationTypes } from '@platform/core/notifications'
import { QueueNames } from '@platform/core/queues'

import { createProduct } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue } from '../helpers/queue'

// The low-stock warning (TDD_16 §4.4, Step 4.2 PR C): the engine raises `inventory.low` once for each downward crossing
// of a product's threshold, and the api turns it into a notification for the members who may see the stock
describe('The inventory.low notification', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const pushQueue = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS)).useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.notification.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } }
    })
  })

  const emit = (payload: object) => app.get(EventEmitter2).emitAsync(Events.INVENTORY_LOW, payload)
  const rowsOf = (storeId = ctx.storeA.id) =>
    owner.notification.findMany({ where: { storeId, type: NotificationTypes.INVENTORY_LOW } })
  async function member(
    name: string,
    permissions: Parameters<typeof actorWithPermissions>[2]['permissions']
  ) {
    return actorWithPermissions(owner, app, {
      prefix,
      name: `${name}${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions
    })
  }
  const low = async (extra: object = {}) => {
    const product = await createProduct(owner, { storeId: ctx.storeA.id, name: 'Ceramic mug' })
    return {
      product,
      payload: {
        storeId: ctx.storeA.id,
        productId: product.id,
        available: 2,
        threshold: 5,
        ...extra
      }
    }
  }

  it('tells the members who may view the inventory, and nobody else', async () => {
    const holder = await member('stockHolder', [Permissions.INVENTORY_VIEW])
    const without = await member('stockWithout', [Permissions.PRODUCTS_VIEW])
    const { product, payload } = await low()

    await emit(payload)

    const rows = await rowsOf()
    expect(rows.map(row => row.userId)).toContain(holder.id)
    expect(rows.map(row => row.userId)).not.toContain(without.id)
    expect(rows.map(row => row.userId)).not.toContain(ctx.adminB.id)
    const row = rows.find(candidate => candidate.userId === holder.id)
    expect(row).toMatchObject({
      resourceType: 'product',
      resourceId: product.id,
      actionPath: AppPaths.store.inventoryLow(ctx.storeA.id),
      params: { product: 'Ceramic mug', available: 2, threshold: 5 }
    })
    // Nothing leaves for another store, however the people of it are set up
    expect(await rowsOf(ctx.storeB.id)).toHaveLength(0)
  })

  it('does not tell a member whose access was revoked or suspended', async () => {
    const revoked = await member('stockRevoked', [Permissions.INVENTORY_VIEW])
    const suspended = await member('stockSuspended', [Permissions.INVENTORY_VIEW])
    await owner.membership.updateMany({
      where: { userId: revoked.id, storeId: ctx.storeA.id },
      data: { revokedAt: new Date() }
    })
    await owner.membership.updateMany({
      where: { userId: suspended.id, storeId: ctx.storeA.id },
      data: { status: MembershipStatus.SUSPENDED }
    })
    const { payload } = await low()

    await emit(payload)

    const told = (await rowsOf()).map(row => row.userId)
    expect(told).not.toContain(revoked.id)
    expect(told).not.toContain(suspended.id)
  })

  it('tells nobody about a product that is not in the store of the event', async () => {
    await member('stockOtherStore', [Permissions.INVENTORY_VIEW])
    const stranger = await createProduct(owner, { storeId: ctx.storeB.id })

    await emit({
      storeId: ctx.storeA.id,
      productId: stranger.id,
      available: 1,
      threshold: 5
    })
    await emit({
      storeId: ctx.storeA.id,
      productId: randomUUID(),
      available: 1,
      threshold: 5
    })

    expect(await rowsOf()).toHaveLength(0)
  })

  it('makes one notification for the crossing the engine raises, and again for the next one', async () => {
    const holder = await member('stockCrossing', [Permissions.INVENTORY_VIEW])
    const inventory = app.get(InventoryService, { strict: false })
    const product = await createProduct(owner, { storeId: ctx.storeA.id })
    await owner.product.update({ where: { id: product.id }, data: { lowStockThreshold: 3 } })
    const base = {
      storeId: ctx.storeA.id,
      productId: product.id,
      warehouseId: ctx.warehouseA.id
    }
    const move = (type: Type, quantity: number, reason?: InventoryAdjustmentReason) =>
      inventory.move({
        ...base,
        type,
        quantity,
        ...(reason === undefined ? {} : { reason }),
        idempotencyKey: `${prefix}-${randomUUID()}`
      })
    const told = async () => (await rowsOf()).filter(row => row.userId === holder.id).length
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    // The listener runs after the commit: wait for the notification that must come, and give a quiet window to the
    // ones that must not
    const toBe = async (expected: number) => {
      for (let attempt = 0; attempt < 50 && (await told()) < expected; attempt += 1)
        await pause(100)
      return told()
    }
    const quiet = () => pause(500)

    await move(Type.RECEIPT, 6, InventoryAdjustmentReason.OPENING_STOCK)
    await move(Type.ADJUSTMENT_OUT, 2, InventoryAdjustmentReason.LOST) // 4: above
    await quiet()
    expect(await told()).toBe(0)
    await move(Type.ADJUSTMENT_OUT, 1, InventoryAdjustmentReason.LOST) // 3: at the threshold, crossed
    await move(Type.ADJUSTMENT_OUT, 1, InventoryAdjustmentReason.LOST) // 2: already under, not again
    expect(await toBe(1)).toBe(1)
    await quiet()
    expect(await told()).toBe(1)
    await move(Type.RECEIPT, 5, InventoryAdjustmentReason.FOUND) // 7: re-armed
    await move(Type.ADJUSTMENT_OUT, 5, InventoryAdjustmentReason.LOST) // 2: crossed again
    expect(await toBe(2)).toBe(2)
    await quiet()
    expect(await told()).toBe(2)
  })
})
