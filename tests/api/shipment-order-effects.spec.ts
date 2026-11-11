import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CodStatus,
  InventoryMovementType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { NotificationTypes } from '@platform/core/notifications'

import { OrderShipmentEffects } from '../../apps/api/src/modules/orders/order-shipment-effects.service'
import { createCarrierConnection, createInventoryLevel, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const CONFLICT = 409
const ATTEMPTS = 80
const POLL_MS = 100
const DAY_MS = 24 * 60 * 60 * 1000

const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }

// The listener runs after the answer: wait for what it must have done instead of reading at once
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let attempt = 0; attempt < ATTEMPTS && !done(value); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    value = await read()
  }
  return value
}

describe('The order follows its shipment (TDD_17 §4.9, §4.4, §4.7)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let localId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    localId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'EF' })).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  // An order that is ready to ship, with one unit reserved in warehouse A (what a confirmed order holds)
  async function reserved(over: { paymentMethod?: string; paymentStatus?: string } = {}) {
    const order = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: OrderStatus.CONFIRMED,
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id,
      ...over
    })
    await createInventoryLevel(owner, {
      storeId: ctx.storeA.id,
      productId: order.productId,
      warehouseId: ctx.warehouseA.id,
      onHand: 5,
      reserved: 1
    })
    return order
  }
  async function guide(orderId: string): Promise<string> {
    const made = await asAdmin()
      .post(ApiRoutes.shipments.forOrder(orderId))
      .send({ connectionId: localId })
    expect(made.status).toBe(CREATED)
    return (made.body as { id: string }).id
  }
  const move = (shipmentId: string, status: ShipmentStatus, extra: Record<string, unknown> = {}) =>
    asAdmin()
      .post(ApiRoutes.shipments.status(shipmentId))
      .send({ status, ...extra })
  const orderOf = (orderId: string) => owner.order.findUniqueOrThrow({ where: { id: orderId } })
  const issuesOf = (orderId: string) =>
    owner.inventoryMovement.findMany({
      where: { referenceId: orderId, type: InventoryMovementType.ISSUE }
    })
  const waitForStatus = (orderId: string, status: OrderStatus) =>
    until(
      () => orderOf(orderId),
      order => order.status === String(status)
    )
  const notices = (shipmentId: string, type: string) =>
    owner.notification.findMany({ where: { resourceId: shipmentId, type } })

  it('ships the order with the stock issue when the package is picked up, once', async () => {
    const order = await reserved()
    const shipmentId = await guide(order.id)
    expect((await move(shipmentId, ShipmentStatus.PICKED_UP)).status).toBe(OK)

    const shipped = await waitForStatus(order.id, OrderStatus.SHIPPED)
    expect(shipped.status).toBe(OrderStatus.SHIPPED)
    expect(shipped.shippedAt).not.toBeNull()
    expect(await issuesOf(order.id)).toHaveLength(1)
    const level = await owner.inventoryLevel.findFirstOrThrow({
      where: { productId: order.productId, warehouseId: ctx.warehouseA.id }
    })
    expect({ onHand: level.onHand, reserved: level.reserved }).toEqual({ onHand: 4, reserved: 0 })

    // The next statuses of the same package add no second issue and no second shipment of the order
    expect((await move(shipmentId, ShipmentStatus.IN_TRANSIT)).status).toBe(OK)
    expect((await move(shipmentId, ShipmentStatus.OUT_FOR_DELIVERY)).status).toBe(OK)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(await issuesOf(order.id)).toHaveLength(1)
    expect((await orderOf(order.id)).status).toBe(OrderStatus.SHIPPED)
  })

  it('writes who did it and the line in the history of the order', async () => {
    const order = await reserved()
    const shipmentId = await guide(order.id)
    await move(shipmentId, ShipmentStatus.PICKED_UP)
    await waitForStatus(order.id, OrderStatus.SHIPPED)
    const entries = await until(
      () =>
        owner.auditLog.findMany({
          where: { resourceId: order.id, action: 'order.status_changed' }
        }),
      rows => rows.length >= 1
    )
    expect(entries[0]?.metadata).toMatchObject({ to: OrderStatus.SHIPPED, shipmentId })
  })

  it('counts three failed attempts on three days and then a delivery completes the order', async () => {
    const order = await reserved()
    const shipmentId = await guide(order.id)
    // The guide was made ten days ago, so that its days can be told apart
    const start = Date.now() - 10 * DAY_MS
    await owner.shipment.update({ where: { id: shipmentId }, data: { createdAt: new Date(start) } })
    const at = (days: number) => new Date(start + days * DAY_MS).toISOString()
    for (const [status, day] of [
      [ShipmentStatus.PICKED_UP, 1],
      [ShipmentStatus.OUT_FOR_DELIVERY, 2],
      [ShipmentStatus.FAILED_ATTEMPT, 2.5],
      [ShipmentStatus.FAILED_ATTEMPT, 3.5],
      [ShipmentStatus.FAILED_ATTEMPT, 4.5]
    ] as const) {
      expect((await move(shipmentId, status, { occurredAt: at(day) })).status).toBe(OK)
    }
    const afterAttempts = await owner.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    expect(afterAttempts.failedAttempts).toBe(3)
    expect(afterAttempts.status).toBe(ShipmentStatus.FAILED_ATTEMPT)
    // The team heard of each failure
    const told = await until(
      () =>
        owner.notification.findMany({
          where: {
            resourceId: shipmentId,
            type: NotificationTypes.SHIPMENT_FAILED_ATTEMPT,
            userId: ctx.adminA.id
          }
        }),
      rows => rows.length >= 3
    )
    expect(told).toHaveLength(3)
    // The order is on its way, not delivered, after three failures
    expect((await waitForStatus(order.id, OrderStatus.SHIPPED)).status).toBe(OrderStatus.SHIPPED)

    expect((await move(shipmentId, ShipmentStatus.DELIVERED, { occurredAt: at(5) })).status).toBe(
      OK
    )
    const delivered = await waitForStatus(order.id, OrderStatus.DELIVERED)
    expect(delivered.status).toBe(OrderStatus.DELIVERED)
    expect(delivered.deliveredAt?.toISOString()).toBe(at(5))
    // Delivery is not an attempt that failed
    expect(
      (await owner.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).failedAttempts
    ).toBe(3)
    expect(await issuesOf(order.id)).toHaveLength(1)
  })

  it('completes the payment of a cash-on-delivery order, and leaves a prepaid one as it was', async () => {
    const cod = await reserved({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY })
    const codShipment = await guide(cod.id)
    expect((await owner.shipment.findUniqueOrThrow({ where: { id: codShipment } })).codStatus).toBe(
      CodStatus.NOT_DELIVERED
    )
    await move(codShipment, ShipmentStatus.DELIVERED)
    const done = await waitForStatus(cod.id, OrderStatus.DELIVERED)
    expect(done.paymentStatus).toBe(PaymentStatus.COMPLETED)
    expect((await owner.shipment.findUniqueOrThrow({ where: { id: codShipment } })).codStatus).toBe(
      CodStatus.PENDING_REMITTANCE
    )
    // From a guide straight to delivered: the stock left once, on the way
    expect(await issuesOf(cod.id)).toHaveLength(1)
    expect(done.shippedAt).not.toBeNull()

    const prepaid = await reserved({
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING
    })
    const prepaidShipment = await guide(prepaid.id)
    await move(prepaidShipment, ShipmentStatus.DELIVERED)
    const prepaidDone = await waitForStatus(prepaid.id, OrderStatus.DELIVERED)
    expect(prepaidDone.paymentStatus).toBe(PaymentStatus.PENDING)
    expect(
      (await owner.shipment.findUniqueOrThrow({ where: { id: prepaidShipment } })).codStatus
    ).toBe(CodStatus.NOT_APPLICABLE)
  })

  it('keeps refusing a hand-made SHIPPED or DELIVERED while a guide is alive, and no way ships the order without the issue', async () => {
    const order = await reserved()
    await guide(order.id)
    for (const status of [OrderStatus.SHIPPED, OrderStatus.DELIVERED]) {
      const refused = await asAdmin().post(ApiRoutes.orders.status(order.id)).send({ status })
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.ORDER_STATUS_DRIVEN_BY_SHIPMENT
      )
    }
    expect(await issuesOf(order.id)).toHaveLength(0)
    expect((await orderOf(order.id)).status).toBe(OrderStatus.CONFIRMED)
  })

  it('does not ship the order of a package that left after the order was cancelled, and asks a person to look', async () => {
    const order = await reserved()
    const shipmentId = await guide(order.id)
    await owner.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } })
    await move(shipmentId, ShipmentStatus.PICKED_UP)
    const told = await until(
      () => notices(shipmentId, NotificationTypes.SHIPMENT_REQUIRES_REVIEW),
      rows => rows.length >= 1
    )
    expect(told.length).toBeGreaterThanOrEqual(1)
    expect((await orderOf(order.id)).status).toBe(OrderStatus.CANCELLED)
    expect(await issuesOf(order.id)).toHaveLength(0)
    // The next status of the same package does not tell them again
    const before = told.length
    await move(shipmentId, ShipmentStatus.IN_TRANSIT)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(await notices(shipmentId, NotificationTypes.SHIPMENT_REQUIRES_REVIEW)).toHaveLength(
      before
    )
  })

  it('tells the team when the stock cannot leave, and heals with the next status of the package', async () => {
    // No level for the unit: the issue fails, the carrier's word is recorded all the same
    const order = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: OrderStatus.CONFIRMED,
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id
    })
    const shipmentId = await guide(order.id)
    expect((await move(shipmentId, ShipmentStatus.PICKED_UP)).status).toBe(OK)
    const told = await until(
      () => notices(shipmentId, NotificationTypes.SHIPMENT_REQUIRES_REVIEW),
      rows => rows.length >= 1
    )
    expect(told.length).toBeGreaterThanOrEqual(1)
    expect((await owner.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe(
      ShipmentStatus.PICKED_UP
    )
    expect((await orderOf(order.id)).status).toBe(OrderStatus.CONFIRMED)

    // Somebody puts the stock right; the next event brings the order to where its package is
    await createInventoryLevel(owner, {
      storeId: ctx.storeA.id,
      productId: order.productId,
      warehouseId: ctx.warehouseA.id,
      onHand: 5,
      reserved: 1
    })
    await move(shipmentId, ShipmentStatus.IN_TRANSIT)
    expect((await waitForStatus(order.id, OrderStatus.SHIPPED)).status).toBe(OrderStatus.SHIPPED)
    expect(await issuesOf(order.id)).toHaveLength(1)
  })
  it('delivers a split order when the last package that is still alive arrives, even if the other one came back', async () => {
    const order = await reserved()
    const make = (originWarehouseId: string, guideNumber: string) =>
      owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: order.id,
          connectionId: localId,
          originWarehouseId,
          serviceCode: 'standard',
          shippingPayer: 'sender',
          currency: 'USD',
          status: ShipmentStatus.LABEL_CREATED,
          guideNumber,
          idempotencyKey: `split-${guideNumber}`,
          createdBy: 'system'
        },
        select: { id: true }
      })
    const a = await make(ctx.warehouseA.id, `SPA-${Date.now()}`)
    const b = await make(ctx.warehouseASecond.id, `SPB-${Date.now()}`)
    await move(a.id, ShipmentStatus.PICKED_UP)
    await move(b.id, ShipmentStatus.PICKED_UP)
    await waitForStatus(order.id, OrderStatus.SHIPPED)
    // One package arrives while the other is still on its way: the order is not delivered yet
    await move(a.id, ShipmentStatus.DELIVERED)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect((await orderOf(order.id)).status).toBe(OrderStatus.SHIPPED)
    // The other comes back: the one that arrived is all that is left of the order
    await move(b.id, ShipmentStatus.RETURNED)
    expect((await waitForStatus(order.id, OrderStatus.DELIVERED)).status).toBe(
      OrderStatus.DELIVERED
    )
  })

  it('does not ship an order for a package that goes straight back, and keeps the moments of the order honest', async () => {
    const back = await reserved()
    const backShipment = await guide(back.id)
    await move(backShipment, ShipmentStatus.RETURNING)
    await new Promise(resolve => setTimeout(resolve, 600))
    expect((await orderOf(back.id)).status).toBe(OrderStatus.CONFIRMED)
    expect(await issuesOf(back.id)).toHaveLength(0)

    // A delivery dated in the future (a carrier with a clock ahead) never leaves the order delivered in the future
    const order = await reserved()
    const shipmentId = await guide(order.id)
    await move(shipmentId, ShipmentStatus.PICKED_UP)
    await waitForStatus(order.id, OrderStatus.SHIPPED)
    await owner.shipmentEvent.create({
      data: {
        storeId: ctx.storeA.id,
        shipmentId,
        status: ShipmentStatus.DELIVERED,
        occurredAt: new Date(Date.now() + 3 * DAY_MS),
        source: 'webhook',
        payload: { from: ShipmentStatus.PICKED_UP }
      }
    })
    await owner.shipment.update({
      where: { id: shipmentId },
      data: { status: ShipmentStatus.DELIVERED }
    })
    const effects = app.get(OrderShipmentEffects, { strict: false })
    await effects.follow(ctx.storeA.id, shipmentId, { type: 'system', id: null }, false)
    const delivered = await orderOf(order.id)
    expect(delivered.status).toBe(OrderStatus.DELIVERED)
    expect(delivered.deliveredAt?.getTime()).toBeLessThanOrEqual(Date.now())
    expect(delivered.deliveredAt?.getTime()).toBeGreaterThanOrEqual(
      delivered.shippedAt?.getTime() ?? 0
    )
  })

  it('does not take a late event kept in the history for the moment the order shipped', async () => {
    const order = await reserved()
    const shipmentId = await guide(order.id)
    // A line stored but never applied (it carries no `from`), dated long before the guide existed
    await owner.shipmentEvent.create({
      data: {
        storeId: ctx.storeA.id,
        shipmentId,
        status: ShipmentStatus.PICKED_UP,
        occurredAt: new Date(Date.now() - 30 * DAY_MS),
        source: 'webhook'
      }
    })
    await move(shipmentId, ShipmentStatus.PICKED_UP)
    const shipped = await waitForStatus(order.id, OrderStatus.SHIPPED)
    expect(Date.now() - (shipped.shippedAt?.getTime() ?? 0)).toBeLessThan(5 * 60 * 1000)
  })
})
