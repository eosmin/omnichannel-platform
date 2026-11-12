import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  OrderReturnCondition,
  OrderReturnStatus,
  ShipmentEventSource,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { ReturnsService } from '@platform/core/shipping'

import { createCarrierConnection } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type CreatedBody, ordersKit, type OrdersKit } from '../helpers/orders'

// `ReturnsService.receiveFromScan` (Step 4.12 PR R1), the entry of the reception by scanner (PR R2): one package, one transaction.
describe('Receiving a scanned package', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  let returns: ReturnsService
  const actor = () => ({ userId: ctx.adminA.id, storeId: ctx.storeA.id })

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
    returns = app.get(ReturnsService)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // A shipped order of 4 units with a guide in the given status
  async function shipped(status: ShipmentStatus = ShipmentStatus.IN_TRANSIT) {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 4 }] })
    const created = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)
    const order = (created.body as CreatedBody).order
    for (const next of ['CONFIRMED', 'SHIPPED']) {
      await kit.asAdmin().post(ApiRoutes.orders.status(order.id)).send({ status: next })
    }
    const connection = await createCarrierConnection(owner, {
      storeId: ctx.storeA.id,
      prefix: `R${randomUUID()
        .slice(0, 4)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '0')}`
    })
    const shipment = await owner.shipment.create({
      data: {
        storeId: ctx.storeA.id,
        orderId: order.id,
        connectionId: connection.id,
        serviceCode: connection.serviceCode,
        shippingPayer: ShippingPayer.SENDER,
        currency: 'USD',
        status,
        guideNumber: `G-${randomUUID()}`,
        idempotencyKey: `scan-${randomUUID()}`,
        createdBy: 'system'
      },
      select: { id: true }
    })
    const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    return { order, product, shipmentId: shipment.id, itemId: item.id }
  }
  const orderOf = (id: string) => owner.order.findUniqueOrThrow({ where: { id } })
  const failure = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => (error instanceof PlatformException ? error.code : String(error))
    )

  it('makes, receives and completes the return, puts the package back, and returns the order when all of it is back', async () => {
    const { order, product, shipmentId } = await shipped()

    const done = await returns.receiveFromScan(
      ctx.storeA.id,
      { shipmentId, reason: 'DELIVERY_FAILED', condition: OrderReturnCondition.RESELLABLE },
      actor()
    )

    const row = await owner.orderReturn.findUniqueOrThrow({
      where: { id: done.returnId },
      include: { lines: true }
    })
    expect(row).toMatchObject({
      status: OrderReturnStatus.COMPLETED,
      type: 'refund',
      reason: 'DELIVERY_FAILED'
    })
    expect(row.lines).toHaveLength(1)
    expect(row.lines[0]).toMatchObject({ quantity: 4, condition: 'resellable' })
    expect((await orderOf(order.id)).status).toBe('RETURNED')
    expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 10 })
    const shipment = await owner.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    expect(shipment.status).toBe(ShipmentStatus.RETURNED)
    const events = await owner.shipmentEvent.findMany({ where: { shipmentId } })
    expect(events.map(event => [event.status, event.source])).toContainEqual([
      ShipmentStatus.RETURNED,
      ShipmentEventSource.MANUAL
    ])
    await waitForAuditEntries(owner, {
      action: AuditAction.RETURN_RECEIVED_BY_SCAN,
      resourceId: done.returnId
    })
  })

  it('leaves a defective package out of the stock, and a package scanned twice is refused', async () => {
    const { order, product, shipmentId } = await shipped(ShipmentStatus.RETURNING)

    await returns.receiveFromScan(
      ctx.storeA.id,
      { shipmentId, reason: 'REFUSED_BY_CUSTOMER', condition: OrderReturnCondition.DAMAGED },
      actor()
    )

    expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
    expect((await orderOf(order.id)).status).toBe('RETURNED')
    const again = await failure(
      returns.receiveFromScan(
        ctx.storeA.id,
        { shipmentId, reason: 'REFUSED_BY_CUSTOMER', condition: OrderReturnCondition.RESELLABLE },
        actor()
      )
    )
    expect(again).toBe(ErrorCodes.RETURN_ORDER_NOT_DELIVERED)
    expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
    expect(await owner.orderReturn.count({ where: { orderId: order.id } })).toBe(1)
  })

  it('takes a partial package by line, each with its own condition, and keeps the order shipped', async () => {
    const { order, product, shipmentId, itemId } = await shipped()

    await returns.receiveFromScan(
      ctx.storeA.id,
      {
        shipmentId,
        reason: 'OTHER',
        condition: OrderReturnCondition.RESELLABLE,
        lines: [{ orderItemId: itemId, quantity: 1, condition: OrderReturnCondition.RESELLABLE }]
      },
      actor()
    )

    expect((await orderOf(order.id)).status).toBe('SHIPPED')
    expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 7 })
    const over = await failure(
      returns.receiveFromScan(
        ctx.storeA.id,
        {
          shipmentId,
          reason: 'OTHER',
          condition: OrderReturnCondition.RESELLABLE,
          lines: [{ orderItemId: itemId, quantity: 4, condition: OrderReturnCondition.RESELLABLE }]
        },
        actor()
      )
    )
    expect(over).toBe(ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED)
  })

  it('refuses a guide that has not left, a guide of another store, and writes nothing when an item fails', async () => {
    const waiting = await shipped(ShipmentStatus.LABEL_CREATED)
    expect(
      await failure(
        returns.receiveFromScan(
          ctx.storeA.id,
          {
            shipmentId: waiting.shipmentId,
            reason: 'OTHER',
            condition: OrderReturnCondition.RESELLABLE
          },
          actor()
        )
      )
    ).toBe(ErrorCodes.RETURN_ORDER_NOT_DELIVERED)

    const { order, product, shipmentId, itemId } = await shipped()
    expect(
      await failure(
        returns.receiveFromScan(
          ctx.storeB.id,
          { shipmentId, reason: 'OTHER', condition: OrderReturnCondition.RESELLABLE },
          { userId: ctx.adminB.id, storeId: ctx.storeB.id }
        )
      )
    ).toBe(ErrorCodes.RESOURCE_NOT_FOUND)

    // A warehouse the store does not sell from: the whole package rolls back, the stock, the return and the shipment
    const failed = await failure(
      returns.receiveFromScan(
        ctx.storeA.id,
        {
          shipmentId,
          reason: 'OTHER',
          condition: OrderReturnCondition.RESELLABLE,
          lines: [
            {
              orderItemId: itemId,
              quantity: 4,
              condition: OrderReturnCondition.RESELLABLE,
              restockWarehouseId: ctx.warehouseB.id
            }
          ]
        },
        actor()
      )
    )
    expect(failed).toBe(ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED)
    expect(await owner.orderReturn.count({ where: { orderId: order.id } })).toBe(0)
    expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
    expect((await owner.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe(
      ShipmentStatus.IN_TRANSIT
    )
  })

  it('records the money given back by hand and refunds the payment when it is all of it', async () => {
    const { order, shipmentId } = await shipped()
    // The customer paid before the package left (a cash-on-delivery order cannot be marked paid until it is delivered)
    await owner.order.update({ where: { id: order.id }, data: { paymentStatus: 'COMPLETED' } })
    const total = (await orderOf(order.id)).totalCents

    const done = await returns.receiveFromScan(
      ctx.storeA.id,
      {
        shipmentId,
        reason: 'REFUSED_BY_CUSTOMER',
        condition: OrderReturnCondition.RESELLABLE,
        refundAmountCents: total
      },
      actor()
    )

    expect(
      (await owner.orderReturn.findUniqueOrThrow({ where: { id: done.returnId } }))
        .refundAmountCents
    ).toBe(total)
    expect((await orderOf(order.id)).paymentStatus).toBe('REFUNDED')
  })
})
