import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  OrderReturnCondition,
  OrderReturnStatus,
  ShipmentKind,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ReturnsService } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'
import type { CreateShipmentParams } from '@platform/plugins/sdk'

import { OrderShipmentEffects } from '../../apps/api/src/modules/orders/order-shipment-effects.service'
import {
  buildFakeCarrier,
  createCarrierConnection,
  type FakeCarrier,
  FakeCarrierBehaviors
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { type CreatedBody, type ErrorBody, ordersKit, type OrdersKit } from '../helpers/orders'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ReturnBody {
  id: string
  status: string
  returnShipmentId: string | null
}
interface GuideBody {
  id: string
  orderId: string
  returnId: string | null
  kind: string
  status: string
  guideNumber: string | null
}

const CUSTOMER_ADDRESS = {
  line1: 'Calle del cliente 7',
  city: 'Santa Tecla',
  state: 'La Libertad',
  country: 'SV'
}
const WAREHOUSE_ADDRESS = { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' }

// The guide of the way back (Step 4.12 PR R1b-2, TDD_17 §4.11): made for an approved return by a connection whose plugin declares
// RETURN_SHIPMENT, customer to warehouse, never cash on delivery, and received through the return that made it.
describe('The return leg of a return', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  let returns: ReturnsService
  let fake: FakeCarrier
  let forzaId = ''
  let localId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
    returns = app.get(ReturnsService)
    // The fake stands for a carrier that can make the way back: only a variant of it declares the capability, never the core
    fake = buildFakeCarrier({ id: CarrierId.FORZA, returnShipment: true })
    app.get(CarrierRegistry, { strict: false }).register(fake.plugin)
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: WAREHOUSE_ADDRESS }
    })
    forzaId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.FORZA })
    ).id
    localId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'RL' })).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    fake.state.guides.clear()
    fake.state.calls.length = 0
    fake.state.create = FakeCarrierBehaviors.OK
  })

  const admin = () => kit.asAdmin()
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const guideOf = (returnId: string, body: Record<string, unknown> = {}, connectionId = forzaId) =>
    admin()
      .post(ApiRoutes.returns.returnShipment(returnId))
      .send({ connectionId, ...body })
  const createCalls = () =>
    fake.callsTo('createShipment').map(call => call.args as CreateShipmentParams)

  // A delivered order of 4 units, and a return of all of them, approved
  async function approved(status: OrderReturnStatus = OrderReturnStatus.APPROVED) {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 4 }] })
    const created = await admin().post(ApiRoutes.orders.create).send(body)
    expect(created.status).toBe(CREATED)
    const order = (created.body as CreatedBody).order
    await owner.order.update({
      where: { id: order.id },
      data: { shippingAddress: CUSTOMER_ADDRESS }
    })
    for (const next of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) {
      await admin().post(ApiRoutes.orders.status(order.id)).send({ status: next })
    }
    const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    const opened = await admin()
      .post(ApiRoutes.returns.create)
      .send({
        orderId: order.id,
        type: 'refund',
        reason: 'DEFECTIVE',
        lines: [{ orderItemId: item.id, quantity: 4 }]
      })
    expect(opened.status).toBe(CREATED)
    const made = opened.body as ReturnBody
    if (status !== OrderReturnStatus.REQUESTED) {
      expect((await admin().post(ApiRoutes.returns.approve(made.id)).send({})).status).toBe(OK)
    }
    return { order, product, returnId: made.id }
  }

  it('makes the guide from the customer to the warehouse, links it to its return and leaves the order alone', async () => {
    const { order, returnId } = await approved()
    await owner.orderReturn.update({
      where: { id: returnId },
      data: { shippingPayer: ShippingPayer.SENDER }
    })

    const response = await guideOf(returnId, { notes: 'Fragil' })

    expect(response.status).toBe(CREATED)
    const guide = response.body as GuideBody
    expect(guide).toMatchObject({
      orderId: order.id,
      returnId,
      kind: ShipmentKind.RETURN,
      status: ShipmentStatus.LABEL_CREATED
    })
    expect(guide.guideNumber).toMatch(/^FAKE-/)
    // The carrier was asked for the way back: the customer sends, the warehouse receives, nothing is collected, and the store
    // pays (SENDER in the words of the store), so the one the carrier bills is the recipient of this guide
    const params = createCalls().at(-1)
    expect(params).toMatchObject({
      kind: ShipmentKind.RETURN,
      cod: null,
      shippingPayer: ShippingPayer.RECIPIENT,
      notes: 'Fragil',
      sender: { address: { line1: CUSTOMER_ADDRESS.line1, city: CUSTOMER_ADDRESS.city } },
      recipient: { address: { line1: WAREHOUSE_ADDRESS.line1, city: WAREHOUSE_ADDRESS.city } }
    })
    expect(params?.sender.phone).toBe('71234567')
    const row = await owner.shipment.findUniqueOrThrow({ where: { id: guide.id } })
    expect(row).toMatchObject({
      kind: ShipmentKind.RETURN,
      returnId,
      // The warehouse the goods go to: the one that sent them
      originWarehouseId: ctx.warehouseA.id,
      codAmountCents: null,
      codStatus: 'not_applicable'
    })
    expect(
      (await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })).returnShipmentId
    ).toBe(guide.id)
    // The return is still approved (the agent moves it on) and the order does not follow a guide of the way back
    expect((await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })).status).toBe(
      OrderReturnStatus.APPROVED
    )
    const after = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.status).toBe('DELIVERED')
    expect(after.trackingNumber).toBeNull()
  })

  it('does not let a guide of the way back move the order the way an outbound guide does', async () => {
    // A confirmed order whose outbound guide just left would be SHIPPED; the same event of a return guide must change nothing
    const { order, returnId } = await approved()
    await owner.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } })
    const guide = (await guideOf(returnId)).body as GuideBody
    await owner.shipment.update({
      where: { id: guide.id },
      data: { status: ShipmentStatus.IN_TRANSIT }
    })

    await app
      .get(OrderShipmentEffects, { strict: false })
      .follow(ctx.storeA.id, guide.id, { type: 'user', id: ctx.adminA.id }, true)

    const after = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.status).toBe('CONFIRMED')
    expect(after.trackingNumber).toBeNull()
  })

  it('does not take the guide of the way back for the tracking number of the order', async () => {
    const { order, returnId } = await approved()
    // The one live outbound guide has no number yet: the first number that arrives would become the order's tracking number
    const outbound = await owner.shipment.create({
      data: {
        storeId: ctx.storeA.id,
        orderId: order.id,
        connectionId: forzaId,
        serviceCode: 'standard',
        shippingPayer: ShippingPayer.SENDER,
        currency: 'USD',
        status: ShipmentStatus.IN_TRANSIT,
        idempotencyKey: `out-${randomUUID()}`,
        createdBy: 'system'
      }
    })

    expect((await guideOf(returnId)).status).toBe(CREATED)

    expect(
      (await owner.order.findUniqueOrThrow({ where: { id: order.id } })).trackingNumber
    ).toBeNull()
    expect(outbound.guideNumber).toBeNull()
  })

  it('needs a phone for the courier to call', async () => {
    const { order, returnId } = await approved()
    await owner.order.update({ where: { id: order.id }, data: { recipientPhones: [] } })

    const response = await guideOf(returnId)

    expect(response.status).toBe(400)
    expect(errorOf(response).code).toBe(ErrorCodes.SHIPPING_RECIPIENT_PHONE_MISSING)
    expect(fake.callsTo('createShipment')).toHaveLength(0)
  })

  it('does not cancel a return that has a live guide, and cancels it once the guide is over', async () => {
    const { returnId } = await approved()
    const guide = (await guideOf(returnId)).body as GuideBody

    const refused = await admin().post(ApiRoutes.returns.cancel(returnId)).send({})
    expect(refused.status).toBe(CONFLICT)
    expect(errorOf(refused).code).toBe(ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS)
    expect((await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })).status).toBe(
      OrderReturnStatus.APPROVED
    )

    await owner.shipment.update({
      where: { id: guide.id },
      data: { status: ShipmentStatus.CANCELLED }
    })
    expect((await admin().post(ApiRoutes.returns.cancel(returnId)).send({})).status).toBe(OK)
  })

  it('does not make a second guide while one may exist at the carrier, and settles a return guide in review by hand', async () => {
    const { returnId } = await approved()
    const guide = (await guideOf(returnId)).body as GuideBody
    await owner.shipment.update({
      where: { id: guide.id },
      data: { status: ShipmentStatus.REQUIRES_REVIEW }
    })

    const again = await guideOf(returnId)
    expect(again.status).toBe(CONFLICT)
    expect(errorOf(again).code).toBe(ErrorCodes.SHIPPING_OUTCOME_UNKNOWN)

    // The carrier is asked by the number of the order, which is also the reference of the outbound guide: not for this one
    const check = await admin().post(ApiRoutes.shipments.check(guide.id)).send({})
    expect(check.status).toBe(CONFLICT)
    expect(errorOf(check).code).toBe(ErrorCodes.SHIPPING_CHECK_NOT_SUPPORTED)
  })

  it('swaps the payer of the guide when the customer pays', async () => {
    const { returnId } = await approved()
    await owner.orderReturn.update({
      where: { id: returnId },
      data: { shippingPayer: ShippingPayer.RECIPIENT }
    })

    expect((await guideOf(returnId)).status).toBe(CREATED)

    expect(createCalls().at(-1)?.shippingPayer).toBe(ShippingPayer.SENDER)
  })

  it('goes to the warehouse that sent the goods unless the agent names another one linked to the store', async () => {
    const { returnId } = await approved()
    const refused = await guideOf(returnId, { warehouseId: ctx.warehouseB.id })

    expect(refused.status).toBe(400)
    expect(errorOf(refused).code).toBe(ErrorCodes.SHIPPING_ORIGIN_MISSING)
    expect(fake.callsTo('createShipment')).toHaveLength(0)
    expect(await owner.shipment.count({ where: { returnId } })).toBe(0)
  })

  it('refuses a carrier that does not declare the capability, a return that is not approved and a second live guide', async () => {
    const { returnId } = await approved()
    const noCapability = await guideOf(returnId, {}, localId)
    expect(noCapability.status).toBe(CONFLICT)
    expect(errorOf(noCapability).code).toBe(ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING)

    const requested = await approved(OrderReturnStatus.REQUESTED)
    const early = await guideOf(requested.returnId)
    expect(early.status).toBe(CONFLICT)
    expect(errorOf(early).code).toBe(ErrorCodes.RETURN_INVALID_STATUS_TRANSITION)

    expect((await guideOf(returnId)).status).toBe(CREATED)
    const twice = await guideOf(returnId)
    expect(twice.status).toBe(CONFLICT)
    expect(errorOf(twice).code).toBe(ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS)
    expect(fake.callsTo('createShipment')).toHaveLength(1)
  })

  it('lets a new guide replace one the carrier refused, and links the return to the last one', async () => {
    const { returnId } = await approved()
    fake.state.create = FakeCarrierBehaviors.REJECT

    const failed = await guideOf(returnId)
    expect(failed.status).toBe(400)
    expect(errorOf(failed).code).toBe(ErrorCodes.SHIPPING_CARRIER_REJECTED)
    const first = await owner.shipment.findFirstOrThrow({ where: { returnId } })
    expect(first.status).toBe(ShipmentStatus.FAILED)

    fake.state.create = FakeCarrierBehaviors.OK
    const again = await guideOf(returnId)

    expect(again.status).toBe(CREATED)
    const rows = await owner.shipment.findMany({
      where: { returnId },
      orderBy: { createdAt: 'asc' }
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.idempotencyKey).not.toBe(rows[1]?.idempotencyKey)
    expect(
      (await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })).returnShipmentId
    ).toBe((again.body as GuideBody).id)
  })

  it('asks for returns:manage and for shipping:manage, and never shows a return of another store', async () => {
    const { returnId } = await approved()
    const manager = await actorWithPermissions(owner, app, {
      prefix,
      name: 'returnsOnly',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.RETURNS_VIEW, Permissions.RETURNS_MANAGE]
    })
    const denied = await api(app, manager, ctx.storeA)
      .post(ApiRoutes.returns.returnShipment(returnId))
      .send({ connectionId: forzaId })
    expect(denied.status).toBe(FORBIDDEN)

    const other = await api(app, ctx.adminB, ctx.storeB)
      .post(ApiRoutes.returns.returnShipment(returnId))
      .send({ connectionId: forzaId })
    expect(other.status).toBe(NOT_FOUND)
    expect(fake.callsTo('createShipment')).toHaveLength(0)
  })

  it('refuses a body that is not the one it knows, so the payer, the cash and the store never come from it', async () => {
    const { returnId } = await approved()
    for (const extra of [
      { shippingPayer: ShippingPayer.SENDER },
      { cod: { amountCents: 100 } },
      { storeId: randomUUID() },
      { originWarehouseId: randomUUID() }
    ]) {
      expect((await guideOf(returnId, extra)).status).toBe(400)
    }
    expect(fake.callsTo('createShipment')).toHaveLength(0)
  })

  describe('receiving the package of the way back', () => {
    it('receives the return that made the guide, counts the units once and says the guide arrived', async () => {
      const { order, product, returnId } = await approved()
      const guide = (await guideOf(returnId)).body as GuideBody
      await owner.shipment.update({
        where: { id: guide.id },
        data: { status: ShipmentStatus.IN_TRANSIT }
      })

      const done = await returns.receiveFromScan(
        ctx.storeA.id,
        {
          shipmentId: guide.id,
          reason: 'DEFECTIVE',
          condition: OrderReturnCondition.RESELLABLE
        },
        { userId: ctx.adminA.id, storeId: ctx.storeA.id }
      )

      // The return of the guide, not a second one
      expect(done.returnId).toBe(returnId)
      expect(await owner.orderReturn.count({ where: { orderId: order.id } })).toBe(1)
      const row = await owner.orderReturn.findUniqueOrThrow({
        where: { id: returnId },
        include: { lines: true }
      })
      expect(row.status).toBe(OrderReturnStatus.COMPLETED)
      expect(row.lines[0]).toMatchObject({ quantity: 4, condition: 'resellable' })
      expect((await owner.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        'RETURNED'
      )
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 10 })
      expect((await owner.shipment.findUniqueOrThrow({ where: { id: guide.id } })).status).toBe(
        ShipmentStatus.DELIVERED
      )

      // Scanned again: the return is over, nothing is counted twice
      await expect(
        returns.receiveFromScan(
          ctx.storeA.id,
          { shipmentId: guide.id, reason: 'DEFECTIVE', condition: OrderReturnCondition.RESELLABLE },
          { userId: ctx.adminA.id, storeId: ctx.storeA.id }
        )
      ).rejects.toMatchObject({ code: ErrorCodes.RETURN_INVALID_STATUS_TRANSITION })
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 10 })
    })

    it('receives a package whose guide was cancelled meanwhile, and refuses one whose guide was never made', async () => {
      const { returnId } = await approved()
      const guide = (await guideOf(returnId)).body as GuideBody
      await owner.shipment.update({
        where: { id: guide.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      const scan = {
        shipmentId: guide.id,
        reason: 'DEFECTIVE',
        condition: OrderReturnCondition.RESELLABLE
      }
      const by = { userId: ctx.adminA.id, storeId: ctx.storeA.id }

      expect((await returns.receiveFromScan(ctx.storeA.id, scan, by)).returnId).toBe(returnId)

      const other = await approved()
      const failed = await owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: other.order.id,
          connectionId: forzaId,
          kind: ShipmentKind.RETURN,
          returnId: other.returnId,
          serviceCode: 'standard',
          shippingPayer: ShippingPayer.SENDER,
          currency: 'USD',
          status: ShipmentStatus.FAILED,
          idempotencyKey: `failed-${randomUUID()}`,
          createdBy: 'system'
        }
      })
      await expect(
        returns.receiveFromScan(ctx.storeA.id, { ...scan, shipmentId: failed.id }, by)
      ).rejects.toMatchObject({ code: ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION })
    })

    it('counts the units in the warehouse the guide went to, not the one that sent them', async () => {
      const { product, returnId } = await approved()
      await owner.warehouse.update({
        where: { id: ctx.warehouseASecond.id },
        data: { address: { line1: 'Bodega 2', city: 'Ilopango', country: 'SV' } }
      })
      const guide = await guideOf(returnId, { warehouseId: ctx.warehouseASecond.id })
      expect(guide.status).toBe(CREATED)
      expect(
        (await owner.shipment.findUniqueOrThrow({ where: { id: (guide.body as GuideBody).id } }))
          .originWarehouseId
      ).toBe(ctx.warehouseASecond.id)

      await returns.receiveFromScan(
        ctx.storeA.id,
        {
          shipmentId: (guide.body as GuideBody).id,
          reason: 'DEFECTIVE',
          condition: OrderReturnCondition.RESELLABLE
        },
        { userId: ctx.adminA.id, storeId: ctx.storeA.id }
      )

      expect(await kit.level(product.id, ctx.warehouseASecond.id)).toMatchObject({ onHand: 4 })
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
    })

    it('refuses lines that are not all the lines of the return with their units, so units that did not arrive are never counted', async () => {
      const { product, returnId } = await approved()
      const guide = (await guideOf(returnId)).body as GuideBody
      const item = await owner.orderItem.findFirstOrThrow({ where: { productId: product.id } })

      await expect(
        returns.receiveFromScan(
          ctx.storeA.id,
          {
            shipmentId: guide.id,
            reason: 'DEFECTIVE',
            condition: OrderReturnCondition.RESELLABLE,
            lines: [
              { orderItemId: item.id, quantity: 3, condition: OrderReturnCondition.RESELLABLE }
            ]
          },
          { userId: ctx.adminA.id, storeId: ctx.storeA.id }
        )
      ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_INVALID_INPUT })

      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
      expect((await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })).status).toBe(
        OrderReturnStatus.APPROVED
      )
    })

    it('takes the condition and warehouse the scan names for the lines of the return, and refuses a line that is not of it', async () => {
      const { product, returnId } = await approved()
      const guide = (await guideOf(returnId)).body as GuideBody
      const item = await owner.orderItem.findFirstOrThrow({ where: { productId: product.id } })

      await expect(
        returns.receiveFromScan(
          ctx.storeA.id,
          {
            shipmentId: guide.id,
            reason: 'DEFECTIVE',
            condition: OrderReturnCondition.RESELLABLE,
            lines: [
              { orderItemId: randomUUID(), quantity: 1, condition: OrderReturnCondition.DAMAGED }
            ]
          },
          { userId: ctx.adminA.id, storeId: ctx.storeA.id }
        )
      ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_INVALID_INPUT })

      await returns.receiveFromScan(
        ctx.storeA.id,
        {
          shipmentId: guide.id,
          reason: 'DEFECTIVE',
          condition: OrderReturnCondition.RESELLABLE,
          lines: [{ orderItemId: item.id, quantity: 4, condition: OrderReturnCondition.DAMAGED }]
        },
        { userId: ctx.adminA.id, storeId: ctx.storeA.id }
      )

      // Damaged units come back and are discarded: the net stock does not change
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
    })
  })
})
