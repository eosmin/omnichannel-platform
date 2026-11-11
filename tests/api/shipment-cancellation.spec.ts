import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  GuideRefundStatus,
  InventoryMovementType,
  OrderCancellationReasons,
  OrderStatus,
  PaymentMethod,
  PickupStatus,
  ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { NotificationTypes } from '@platform/core/notifications'
import { type CancelShipmentJob, JobNames, QueueNames } from '@platform/core/queues'
import { ShipmentCancellation, VoidSettlements } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import {
  buildFakeCarrier,
  createCarrierConnection,
  createInventoryLevel,
  createOrder,
  type FakeCarrier,
  FakeCarrierBehaviors
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import type { CapturedQueue } from '../helpers/queue'

const OK = 200
const CREATED = 201
const CONFLICT = 409
const ATTEMPTS = 80
const POLL_MS = 100

const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }
const PACKING_NOTE = 'FRAGILE-PACKING-NOTE-8841'

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let attempt = 0; attempt < ATTEMPTS && !done(value); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    value = await read()
  }
  return value
}

interface ErrorBody {
  error: { code: string }
}

describe('Cancelling guides: with the order, by an edit, by hand (TDD_17 §4.8)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let forza: FakeCarrier
  let noVoid: FakeCarrier
  let registry: CarrierRegistry
  let cancellation: ShipmentCancellation
  let queue: CapturedQueue
  let localId = ''
  let forzaId = ''
  let noVoidId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(CarrierRegistry, { strict: false })
    forza = buildFakeCarrier({
      id: CarrierId.FORZA,
      cancel: true,
      pickupRequest: true,
      pickupModify: true,
      pickupCancel: true
    })
    // A carrier that has no way to void a guide
    noVoid = buildFakeCarrier({ id: CarrierId.C807, cancel: false })
    registry.register(forza.plugin)
    registry.register(noVoid.plugin)
    cancellation = app.get(ShipmentCancellation, { strict: false })
    queue = app.get<CapturedQueue>(getQueueToken(QueueNames.HEAVY_PROCESSING), { strict: false })
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    localId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'CX' })).id
    forzaId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.FORZA })
    ).id
    noVoidId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.C807 })
    ).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    for (const fake of [forza, noVoid]) {
      fake.state.guides.clear()
      fake.state.pickups.clear()
      fake.state.calls.length = 0
      fake.state.create = FakeCarrierBehaviors.OK
      fake.state.cancel = FakeCarrierBehaviors.OK
    }
    queue.jobs.length = 0
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  async function reserved(over: Record<string, unknown> = {}) {
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
  const ship = (orderId: string, connectionId: string) =>
    asAdmin().post(ApiRoutes.shipments.forOrder(orderId)).send({ connectionId })
  async function guide(orderId: string, connectionId: string): Promise<string> {
    const made = await ship(orderId, connectionId)
    expect(made.status).toBe(CREATED)
    return (made.body as { id: string }).id
  }
  const cancelOrder = (orderId: string) =>
    asAdmin().post(ApiRoutes.orders.status(orderId)).send({
      status: 'CANCELLED',
      cancellationReason: OrderCancellationReasons.CUSTOMER_REQUEST
    })
  const edit = (orderId: string, body: Record<string, unknown>) =>
    asAdmin().patch(ApiRoutes.orders.byId(orderId)).send(body)
  const shipmentOf = (id: string) => owner.shipment.findUniqueOrThrow({ where: { id } })
  const orderOf = (id: string) => owner.order.findUniqueOrThrow({ where: { id } })
  const releasesOf = (orderId: string) =>
    owner.inventoryMovement.findMany({
      where: { referenceId: orderId, type: InventoryMovementType.RELEASE }
    })
  const settle = (shipmentId: string, lastAttempt = false) =>
    cancellation.settle(ctx.storeA.id, shipmentId, carrierId => registry.find(carrierId), {
      actor: { type: 'user', id: ctx.adminA.id },
      lastAttempt
    })
  // Each member who manages shipments is told once, however many times the carrier said no
  const expectOneLinePerMember = (rows: { userId: string }[]) => {
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(new Set(rows.map(row => row.userId)).size).toBe(rows.length)
  }
  const voidJobs = () => queue.jobs.filter(job => job.name === JobNames.CANCEL_SHIPMENT)
  const notices = (shipmentId: string) =>
    owner.notification.findMany({
      where: { resourceId: shipmentId, type: NotificationTypes.SHIPMENT_CANCEL_FAILED }
    })

  describe('cancelling the order', () => {
    it('cancels the order at once, releases its stock once and voids the guide by a job that can run twice', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, forzaId)

      const cancelled = await cancelOrder(order.id)
      expect(cancelled.status).toBe(OK)
      expect((await orderOf(order.id)).status).toBe(OrderStatus.CANCELLED)
      expect((await shipmentOf(shipmentId)).status).toBe(ShipmentStatus.CANCEL_PENDING)
      expect(await releasesOf(order.id)).toHaveLength(1)
      // The carrier was not asked inside the request: a job asks it, with five attempts
      expect(forza.callsTo('cancelShipment')).toHaveLength(0)
      expect(voidJobs()).toHaveLength(1)
      const [job] = voidJobs()
      expect(job?.data).toEqual({
        storeId: ctx.storeA.id,
        shipmentId,
        requestedBy: ctx.adminA.id
      } satisfies CancelShipmentJob)
      expect(job?.opts).toMatchObject({ attempts: 5, backoff: { type: 'exponential' } })

      expect(await settle(shipmentId)).toBe(VoidSettlements.CANCELLED)
      expect(await settle(shipmentId)).toBe(VoidSettlements.SKIPPED)
      expect(forza.callsTo('cancelShipment')).toHaveLength(1)
      expect(await shipmentOf(shipmentId)).toMatchObject({
        status: ShipmentStatus.CANCELLED,
        refundStatus: GuideRefundStatus.PENDING
      })
      // Neither the job nor its repeat released the stock again
      expect(await releasesOf(order.id)).toHaveLength(1)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.ORDER_CANCELLED,
        resourceId: order.id
      })
      expect(entries[0]?.metadata).toMatchObject({ shipmentsVoided: [shipmentId] })
    })

    it('voids a local guide at once, with the order', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, localId)
      expect((await cancelOrder(order.id)).status).toBe(OK)
      expect(await shipmentOf(shipmentId)).toMatchObject({
        status: ShipmentStatus.CANCELLED,
        refundStatus: GuideRefundStatus.NOT_APPLICABLE
      })
      expect(voidJobs()).toHaveLength(0)
      expect(await releasesOf(order.id)).toHaveLength(1)
    })

    it('tells the team to void the guide itself when the carrier cannot, and lets the agent mark it voided', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, noVoidId)
      expect((await cancelOrder(order.id)).status).toBe(OK)

      expect(await shipmentOf(shipmentId)).toMatchObject({
        status: ShipmentStatus.CANCEL_PENDING,
        refundStatus: GuideRefundStatus.NOT_SUPPORTED
      })
      expect(voidJobs()).toHaveLength(0)
      const told = await until(
        () => notices(shipmentId),
        rows => rows.length >= 1
      )
      expectOneLinePerMember(told)
      // The order stays cancelled and its stock released; the agent settles the guide
      expect(await releasesOf(order.id)).toHaveLength(1)
      const voided = await asAdmin().post(ApiRoutes.shipments.markVoided(shipmentId))
      expect(voided.status).toBe(OK)
      expect((await shipmentOf(shipmentId)).status).toBe(ShipmentStatus.CANCELLED)
    })

    it('leaves the guide cancel-failed when the carrier says no, tells the team once and lets the agent retry', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, forzaId)
      forza.state.cancel = FakeCarrierBehaviors.REJECT
      await cancelOrder(order.id)

      expect(await settle(shipmentId)).toBe(VoidSettlements.FAILED)
      // A refusal is not asked again: the first attempt ends it
      expect(forza.callsTo('cancelShipment')).toHaveLength(1)
      expect(await shipmentOf(shipmentId)).toMatchObject({
        status: ShipmentStatus.CANCEL_FAILED,
        lastError: 'The fake carrier refused to void the guide'
      })
      const told = await until(
        () => notices(shipmentId),
        rows => rows.length >= 1
      )
      expectOneLinePerMember(told)
      expect((await orderOf(order.id)).status).toBe(OrderStatus.CANCELLED)

      // The agent retries: the carrier answers this time
      forza.state.cancel = FakeCarrierBehaviors.OK
      queue.jobs.length = 0
      const retried = await asAdmin().post(ApiRoutes.shipments.cancel(shipmentId))
      expect(retried.body).toMatchObject({ status: ShipmentStatus.CANCEL_PENDING })
      expect(voidJobs()).toHaveLength(1)
      expect(await settle(shipmentId)).toBe(VoidSettlements.CANCELLED)
    })

    it('asks again while the carrier does not answer and gives up on the last attempt', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, forzaId)
      forza.state.cancel = FakeCarrierBehaviors.TIMEOUT_BEFORE
      await cancelOrder(order.id)

      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(await settle(shipmentId, false)).toBe(VoidSettlements.RETRY)
        expect((await shipmentOf(shipmentId)).status).toBe(ShipmentStatus.CANCEL_PENDING)
      }
      expect(await settle(shipmentId, true)).toBe(VoidSettlements.FAILED)
      expect(await shipmentOf(shipmentId)).toMatchObject({
        status: ShipmentStatus.CANCEL_FAILED,
        lastError: 'unknown_outcome'
      })
      // The same key each time: a carrier that kept the first void does not make a second
      const keys = forza.callsTo('cancelShipment').map(call => JSON.stringify(call.args))
      expect(new Set(keys).size).toBe(1)
    })

    it.each([ShipmentStatus.CANCEL_PENDING, ShipmentStatus.CANCEL_FAILED])(
      'does not start a second void for a guide that is %s: the agent settles it',
      async status => {
        const order = await reserved()
        const shipmentId = await guide(order.id, forzaId)
        await owner.shipment.update({
          where: { id: shipmentId },
          data: { status, cancelRequestedAt: new Date() }
        })
        const cancelled = await cancelOrder(order.id)
        expect(cancelled.status).toBe(OK)
        expect(voidJobs()).toHaveLength(0)
        expect(forza.callsTo('cancelShipment')).toHaveLength(0)
        expect((await shipmentOf(shipmentId)).status).toBe(status)
      }
    )

    it('refuses to cancel the order of a package that left or whose outcome is unknown, and changes nothing', async () => {
      const left = await reserved()
      const leftId = await guide(left.id, localId)
      // Written by hand, so that the order does not follow the package (it would be SHIPPED, and refused for that); the
      // listener of the guide just made reads the shipment after the answer, so it is let go first
      await new Promise(resolve => setTimeout(resolve, 500))
      await owner.shipment.update({
        where: { id: leftId },
        data: { status: ShipmentStatus.PICKED_UP }
      })
      const refusedLeft = await cancelOrder(left.id)
      expect(refusedLeft.status).toBe(CONFLICT)
      expect((refusedLeft.body as ErrorBody).error.code).toBe(
        ErrorCodes.SHIPPING_CANNOT_CANCEL_AFTER_PICKUP
      )

      const unknown = await reserved()
      forza.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      const made = await ship(unknown.id, forzaId)
      const reviewId =
        (made.body as { error: { metadata?: { shipmentId?: string } } }).error.metadata
          ?.shipmentId ?? ''
      const refused = await cancelOrder(unknown.id)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.SHIPPING_OUTCOME_UNKNOWN)
      expect((await shipmentOf(reviewId)).status).toBe(ShipmentStatus.REQUIRES_REVIEW)
      for (const id of [left.id, unknown.id]) {
        expect((await orderOf(id)).status).toBe(OrderStatus.CONFIRMED)
        expect(await releasesOf(id)).toHaveLength(0)
      }
    })
  })

  describe('editing what a guide was made from (cancel and recreate)', () => {
    it('voids the guide when the address changes, makes the new guide wait for the old, and then lets it be made', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, forzaId)

      const edited = await edit(order.id, { shippingAddress: { ...ADDRESS, line1: 'Calle 9 #1' } })
      expect(edited.status).toBe(OK)
      expect((await orderOf(order.id)).status).toBe(OrderStatus.CONFIRMED)
      expect((await shipmentOf(shipmentId)).status).toBe(ShipmentStatus.CANCEL_PENDING)
      expect(voidJobs()).toHaveLength(1)

      // The new guide waits until the old one is CANCELLED
      const early = await ship(order.id, forzaId)
      expect(early.status).toBe(CONFLICT)
      expect((early.body as ErrorBody).error.code).toBe(ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS)
      expect(await settle(shipmentId)).toBe(VoidSettlements.CANCELLED)
      const later = await ship(order.id, forzaId)
      expect(later.status).toBe(CREATED)
      // The stock stayed reserved throughout: an edit of the address is not a cancellation
      expect(await releasesOf(order.id)).toHaveLength(0)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.ORDER_UPDATED,
        resourceId: order.id
      })
      expect(entries[0]?.metadata).toMatchObject({
        shipmentsVoided: [shipmentId],
        guideChanges: ['address']
      })
    })

    it('voids the guide when the payment method changes, and when the phones change', async () => {
      const paid = await reserved({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY })
      const paidId = await guide(paid.id, forzaId)
      expect((await edit(paid.id, { paymentMethod: PaymentMethod.TRANSFER })).status).toBe(OK)
      expect((await shipmentOf(paidId)).status).toBe(ShipmentStatus.CANCEL_PENDING)

      const phoned = await reserved()
      const phonedId = await guide(phoned.id, forzaId)
      expect((await edit(phoned.id, { recipientPhones: ['70001234'] })).status).toBe(OK)
      expect((await shipmentOf(phonedId)).status).toBe(ShipmentStatus.CANCEL_PENDING)
    })

    it('leaves the guide alone when the edit is of something else, or says the same address in another order of keys', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, forzaId)
      expect((await edit(order.id, { customerNotes: 'Ring twice' })).status).toBe(OK)
      expect(
        (
          await edit(order.id, {
            shippingAddress: {
              country: 'SV',
              state: 'San Salvador',
              city: 'San Salvador',
              line1: 'Calle 1 #23'
            }
          })
        ).status
      ).toBe(OK)
      expect((await shipmentOf(shipmentId)).status).toBe(ShipmentStatus.LABEL_CREATED)
      expect(voidJobs()).toHaveLength(0)
    })

    it('voids the guide when the planned carrier changes', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, forzaId)
      const edited = await edit(order.id, { carrierConnectionId: localId })
      expect(edited.status).toBe(OK)
      expect((await shipmentOf(shipmentId)).status).toBe(ShipmentStatus.CANCEL_PENDING)
    })

    it('lets the address of a package that already left be edited, and leaves its guide alone', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, localId)
      await new Promise(resolve => setTimeout(resolve, 500))
      await owner.shipment.update({
        where: { id: shipmentId },
        data: { status: ShipmentStatus.IN_TRANSIT }
      })
      await owner.order.update({ where: { id: order.id }, data: { status: OrderStatus.SHIPPED } })
      const edited = await edit(order.id, { shippingAddress: { ...ADDRESS, line1: 'Calle 9 #1' } })
      expect(edited.status).toBe(OK)
      expect((await shipmentOf(shipmentId)).status).toBe(ShipmentStatus.IN_TRANSIT)
    })

    it('names the guide that blocks an order, and changes nothing', async () => {
      const order = await reserved()
      forza.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      const made = await ship(order.id, forzaId)
      const reviewId =
        (made.body as { error: { metadata?: { shipmentId?: string } } }).error.metadata
          ?.shipmentId ?? ''
      const refused = await cancelOrder(order.id)
      expect(
        (refused.body as { error: { metadata?: { shipmentId?: string } } }).error.metadata
      ).toMatchObject({ shipmentId: reviewId })
    })

    it('leaves the guide cancel-failed, which tells the team, when the void cannot be queued', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, forzaId)
      const spy = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis down'))
      try {
        expect((await cancelOrder(order.id)).status).toBe(OK)
      } finally {
        spy.mockRestore()
      }
      expect(await shipmentOf(shipmentId)).toMatchObject({
        status: ShipmentStatus.CANCEL_FAILED,
        lastError: 'not_queued'
      })
      const told = await until(
        () => notices(shipmentId),
        rows => rows.length >= 1
      )
      expectOneLinePerMember(told)
    })

    it('does not change an order whose guide may exist at the carrier', async () => {
      const order = await reserved()
      forza.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      await ship(order.id, forzaId)
      const refused = await edit(order.id, { shippingAddress: { ...ADDRESS, line1: 'Calle 9 #1' } })
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.SHIPPING_OUTCOME_UNKNOWN)
      expect((await orderOf(order.id)).shippingAddress).toMatchObject({ line1: 'Calle 1 #23' })
    })
  })

  describe('a guide that is voided leaves its pickup', () => {
    it('drops the count of the pickup with each guide and cancels a pickup that nobody has asked a carrier for when it is empty', async () => {
      const pickup = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: localId,
          pickupDate: new Date('2026-12-15'),
          status: PickupStatus.MANUAL_REQUIRED,
          packageCount: 2,
          requestedBy: 'system'
        }
      })
      const ids: string[] = []
      for (let index = 0; index < 2; index += 1) {
        const order = await reserved()
        const id = await guide(order.id, localId)
        await owner.shipment.update({ where: { id }, data: { pickupId: pickup.id } })
        ids.push(id)
      }
      await asAdmin().post(ApiRoutes.shipments.cancel(ids[0] ?? ''))
      expect(
        await owner.pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } })
      ).toMatchObject({ packageCount: 1, revision: 2, status: PickupStatus.MANUAL_REQUIRED })
      expect((await shipmentOf(ids[0] ?? '')).pickupId).toBeNull()
      await asAdmin().post(ApiRoutes.shipments.cancel(ids[1] ?? ''))
      expect(
        await owner.pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } })
      ).toMatchObject({ packageCount: 0, status: PickupStatus.CANCELLED })
    })

    it('tells the carrier the new count of a pickup it holds, and cancels it when it is empty', async () => {
      const first = await reserved()
      const second = await reserved()
      const firstId = await guide(first.id, forzaId)
      const secondId = await guide(second.id, forzaId)
      forza.state.pickups.set('PK-1', {
        window: { date: '2026-12-15', from: '09:00', to: '12:00' },
        packageCount: 2
      })
      const pickup = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: forzaId,
          pickupDate: new Date('2026-12-15'),
          status: PickupStatus.REQUESTED,
          packageCount: 2,
          providerPickupId: 'PK-1',
          requestedBy: 'system'
        }
      })
      await owner.shipment.updateMany({
        where: { id: { in: [firstId, secondId] } },
        data: { pickupId: pickup.id }
      })

      await asAdmin().post(ApiRoutes.shipments.cancel(firstId))
      await settle(firstId)
      expect(forza.callsTo('modifyPickup')).toHaveLength(1)
      expect(forza.state.pickups.get('PK-1')?.packageCount).toBe(1)

      await asAdmin().post(ApiRoutes.shipments.cancel(secondId))
      await settle(secondId)
      expect(forza.callsTo('cancelPickup')).toHaveLength(1)
      expect(
        (await owner.pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } })).status
      ).toBe(PickupStatus.CANCELLED)
    })

    it('leaves a note on the pickup when its carrier has no way to cancel it, and still voids the guide', async () => {
      const order = await reserved()
      const shipmentId = await guide(order.id, localId)
      // The local courier has no pickup API: a pickup the platform thinks a carrier holds is a note for the agent
      const pickup = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: localId,
          pickupDate: new Date('2026-12-16'),
          status: PickupStatus.REQUESTED,
          packageCount: 1,
          providerPickupId: 'PK-OTHER',
          requestedBy: 'system'
        }
      })
      await owner.shipment.update({ where: { id: shipmentId }, data: { pickupId: pickup.id } })
      const voided = await asAdmin().post(ApiRoutes.shipments.markVoided(shipmentId))
      expect(voided.status).toBe(CONFLICT)
      await owner.shipment.update({
        where: { id: shipmentId },
        data: { status: ShipmentStatus.CANCEL_PENDING }
      })
      expect((await asAdmin().post(ApiRoutes.shipments.markVoided(shipmentId))).status).toBe(OK)
      expect(await shipmentOf(shipmentId)).toMatchObject({
        status: ShipmentStatus.CANCELLED,
        pickupId: null
      })
      expect(
        await owner.pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } })
      ).toMatchObject({ packageCount: 0, lastError: 'pickup_emptied_carrier_not_cancelled' })
    })
  })

  describe('the packing note', () => {
    it('never reaches the carrier or the label', async () => {
      const order = await reserved({ packingNotes: PACKING_NOTE })
      const shipmentId = await guide(order.id, forzaId)
      expect(JSON.stringify(forza.state.calls)).not.toContain(PACKING_NOTE)
      const row = await shipmentOf(shipmentId)
      expect(JSON.stringify(row)).not.toContain(PACKING_NOTE)
    })
  })
})
