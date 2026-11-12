import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierConnectionStatus,
  CarrierId,
  CodStatus,
  OrderCancellationReasons,
  GuideRefundStatus,
  MediaStatus,
  PaymentMethod,
  PickupStatus,
  PriceApprovalStatus,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { JobNames, QueueNames } from '@platform/core/queues'
import { ShipmentCancellation, ShippingService, VoidSettlements } from '@platform/core/shipping'
import { StorageService } from '@platform/core/storage-module'
import { CarrierRegistry } from '@platform/plugins/runtime'

import {
  buildFakeCarrier,
  createCarrierConnection,
  createOrder,
  FakeCarrierBehaviors,
  type FakeCarrier
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'
import type { CapturedQueue } from '../helpers/queue'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ErrorBody {
  error: { code: string; metadata?: { shipmentId?: string; carrierMessage?: string } }
}

interface ShipmentBody {
  id: string
  orderId: string
  status: string
  guideNumber: string | null
  hasLabel: boolean
  codAmountCents: number | null
  codStatus: string
  refundStatus: string
  failedAttempts: number
  lastError: string | null
  trackingUrl: string | null
  pickupId: string | null
  carrierCostCents: number | null
}

const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }

describe('Shipments: the engine that makes guides (TDD_17 §4.5, §4.8)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let standalone: FakeCarrier
  let pickupBound: FakeCarrier
  let counter = 0
  let localId = ''
  let forzaId = ''
  let c807Id = ''
  let service: ShippingService
  let cancellation: ShipmentCancellation
  let registry: CarrierRegistry
  let storage: StorageService
  let scans: CapturedQueue

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    // The registry holds three ids: the fakes stand for Forza (standalone) and C807 (pickup-bound), each under its own
    registry = app.get(CarrierRegistry, { strict: false })
    standalone = buildFakeCarrier({ id: CarrierId.FORZA, cancel: true, fetchStatus: true })
    pickupBound = buildFakeCarrier({
      id: CarrierId.C807,
      mode: 'pickup_bound',
      maxBatchSize: 2,
      fetchStatus: true
    })
    registry.register(standalone.plugin)
    registry.register(pickupBound.plugin)
    service = app.get(ShippingService, { strict: false })
    cancellation = app.get(ShipmentCancellation, { strict: false })
    storage = app.get(StorageService, { strict: false })
    scans = app.get<CapturedQueue>(getQueueToken(QueueNames.HEAVY_PROCESSING), { strict: false })

    // The origin of every guide of store A: a warehouse with an address
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    localId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'LA' })).id
    forzaId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.FORZA })
    ).id
    c807Id = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.C807 })
    ).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    for (const fake of [standalone, pickupBound]) {
      fake.state.guides.clear()
      fake.state.pickups.clear()
      fake.state.calls.length = 0
      fake.state.create = FakeCarrierBehaviors.OK
      fake.state.cancel = FakeCarrierBehaviors.OK
      fake.state.rejectReferences.clear()
    }
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const metaOf = (body: unknown) => (body as ErrorBody).error.metadata ?? {}
  // An order that is ready to ship: confirmed, with an address and a phone, from warehouse A
  const confirmed = (
    over: Parameters<typeof createOrder>[1] extends infer T ? Partial<T> : never = {}
  ) =>
    createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id,
      ...over
    })
  const ship = (orderId: string, connectionId: string, body: Record<string, unknown> = {}) =>
    asAdmin()
      .post(ApiRoutes.shipments.forOrder(orderId))
      .send({ connectionId, ...body })
  const shipmentsOf = (orderId: string) =>
    owner.shipment.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
  // What the worker does with the job that a cancel queued: asks the carrier once
  const settleVoid = (shipmentId: string, lastAttempt = false) =>
    cancellation.settle(ctx.storeA.id, shipmentId, carrierId => registry.find(carrierId), {
      actor: { type: 'user', id: ctx.adminA.id },
      lastAttempt
    })
  const read = async (id: string): Promise<ShipmentBody> => {
    const response = await asAdmin().get(ApiRoutes.shipments.byId(id))
    expect(response.status).toBe(OK)
    return response.body as ShipmentBody
  }

  describe('the local carrier: our own guide and label', () => {
    it('makes a guide with the next number of its sequence and a label that can be printed', async () => {
      const order = await confirmed({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY })
      const response = await ship(order.id, localId)
      expect(response.status).toBe(CREATED)
      const body = response.body as ShipmentBody
      expect(body).toMatchObject({
        status: ShipmentStatus.LABEL_CREATED,
        hasLabel: true,
        codAmountCents: 1999,
        codStatus: CodStatus.NOT_DELIVERED,
        refundStatus: GuideRefundStatus.NOT_APPLICABLE
      })
      expect(body.guideNumber).toMatch(/^LA-\d{6}$/)

      // The label is a PDF kept once, clean (the platform drew it), and served by a short-lived link
      const row = await owner.shipment.findUniqueOrThrow({ where: { id: body.id } })
      const media = await owner.media.findUniqueOrThrow({ where: { id: row.labelMediaId ?? '' } })
      expect(media).toMatchObject({
        purpose: 'shipping_label',
        status: MediaStatus.CLEAN,
        contentType: 'application/pdf',
        orderId: order.id,
        storeId: ctx.storeA.id
      })
      const stored = await storage.read(media.key, 1_000_000)
      expect(stored?.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      const link = await asAdmin().get(ApiRoutes.shipments.label(body.id))
      expect(link.status).toBe(OK)
      expect((link.body as { url: string }).url).toContain(media.key.split('/').at(-1))
      // The guide is the tracking number of its only shipment
      expect(
        (await owner.order.findUniqueOrThrow({ where: { id: order.id } })).trackingNumber
      ).toBe(body.guideNumber)
    })

    it('draws PAID on the label of a prepaid order: no amount is collected', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      expect(body.codAmountCents).toBeNull()
      expect(body.codStatus).toBe(CodStatus.NOT_APPLICABLE)
    })

    it('gives twenty orders made at once twenty different guides', async () => {
      const orders = await Promise.all(Array.from({ length: 20 }, () => confirmed()))
      const answers = await Promise.all(orders.map(order => ship(order.id, localId)))
      expect(answers.map(answer => answer.status)).toEqual(
        Array.from({ length: 20 }, () => CREATED)
      )
      const guides = answers.map(answer => (answer.body as ShipmentBody).guideNumber)
      expect(new Set(guides).size).toBe(20)
    })

    it('refuses a label it cannot draw whole and gives the number back', async () => {
      const order = await confirmed({ shippingAddress: { ...ADDRESS, line1: '東京都 渋谷区' } })
      const before = await owner.guideSequence.findUniqueOrThrow({
        where: { connectionId: localId }
      })
      const response = await ship(order.id, localId)
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_LABEL_UNDRAWABLE)
      expect(await shipmentsOf(order.id)).toHaveLength(0)
      const after = await owner.guideSequence.findUniqueOrThrow({
        where: { connectionId: localId }
      })
      expect(after.nextValue).toBe(before.nextValue)
    })

    it('can cancel at once and for free, and then makes another guide', async () => {
      const order = await confirmed()
      const first = (await ship(order.id, localId)).body as ShipmentBody
      const cancelled = await asAdmin().post(ApiRoutes.shipments.cancel(first.id))
      expect(cancelled.status).toBe(OK)
      expect(cancelled.body).toMatchObject({
        status: ShipmentStatus.CANCELLED,
        refundStatus: GuideRefundStatus.NOT_APPLICABLE
      })
      // A label that was voided is never printed
      expect(codeOf((await asAdmin().get(ApiRoutes.shipments.label(first.id))).body)).toBe(
        ErrorCodes.SHIPPING_LABEL_NOT_AVAILABLE
      )
      const second = await ship(order.id, localId)
      expect(second.status).toBe(CREATED)
      expect((second.body as ShipmentBody).guideNumber).not.toBe(first.guideNumber)
    })
  })

  describe('exactly one guide per order', () => {
    it('makes one guide when two requests arrive at once', async () => {
      const order = await confirmed()
      const answers = await Promise.all([ship(order.id, forzaId), ship(order.id, forzaId)])
      const statuses = answers.map(answer => answer.status).sort()
      expect(statuses).toEqual([CREATED, CONFLICT])
      const refused = answers.find(answer => answer.status === CONFLICT)
      expect([
        ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS,
        ErrorCodes.SHIPPING_OUTCOME_UNKNOWN
      ]).toContain(codeOf(refused?.body))
      expect(await shipmentsOf(order.id)).toHaveLength(1)
      // The carrier was called once: a guide may cost money
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
      expect(standalone.state.guides.size).toBe(1)
    })

    it('refuses a second guide for the same order afterwards', async () => {
      const order = await confirmed()
      expect((await ship(order.id, forzaId)).status).toBe(CREATED)
      const again = await ship(order.id, forzaId)
      expect(again.status).toBe(CONFLICT)
      expect(codeOf(again.body)).toBe(ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS)
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
    })
  })

  describe('a carrier that makes the guide', () => {
    it('stores the guide, its tracking link, its cost and its label, and asks the scan of the label', async () => {
      const order = await confirmed()
      const jobs = scans.jobs.length
      const response = await ship(order.id, forzaId, { notes: 'Ring twice' })
      expect(response.status).toBe(CREATED)
      const body = response.body as ShipmentBody
      expect(body).toMatchObject({
        status: ShipmentStatus.LABEL_CREATED,
        hasLabel: true,
        carrierCostCents: 350
      })
      expect(body.trackingUrl).toBe(`https://tracking.fake.invalid/${body.guideNumber}`)
      const sent = standalone.callsTo('createShipment')[0]?.args as {
        reference: string
        idempotencyKey: string
        notes: string
        sender: { name: string }
        recipient: { phones: string[] }
      }
      expect(sent.idempotencyKey).toMatch(/^shipment:.+:.+:1$/)
      expect(sent.notes).toBe('Ring twice')
      expect(sent.recipient.phones).toEqual(['71234567'])
      // A file that came from a carrier is scanned like any file from outside
      const row = await owner.shipment.findUniqueOrThrow({ where: { id: body.id } })
      const media = await owner.media.findUniqueOrThrow({ where: { id: row.labelMediaId ?? '' } })
      expect(media.status).toBe(MediaStatus.PENDING)
      expect(scans.jobs.slice(jobs)).toEqual([
        expect.objectContaining({ name: JobNames.SCAN_FILE, data: { mediaId: media.id } })
      ])
      // The label of a shipment that is not clean yet is not served
      expect(codeOf((await asAdmin().get(ApiRoutes.shipments.label(body.id))).body)).toBe(
        ErrorCodes.SHIPPING_LABEL_NOT_AVAILABLE
      )
      await owner.media.update({ where: { id: media.id }, data: { status: MediaStatus.CLEAN } })
      expect((await asAdmin().get(ApiRoutes.shipments.label(body.id))).status).toBe(OK)
    })

    it('writes the history and announces nothing it cannot back: the audit trail has the guide', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, forzaId)).body as ShipmentBody
      const detail = (await asAdmin().get(ApiRoutes.shipments.byId(body.id))).body as {
        events: { status: string; source: string }[]
      }
      expect(detail.events.map(event => event.status).reverse()).toEqual([
        ShipmentStatus.CREATING,
        ShipmentStatus.LABEL_CREATED
      ])
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.SHIPMENT_CREATED,
        resourceId: body.id
      })
      expect(entries).toHaveLength(1)
    })

    it('records a refusal of the carrier as a failed guide and lets the agent try again', async () => {
      const order = await confirmed()
      standalone.state.create = FakeCarrierBehaviors.REJECT
      const refused = await ship(order.id, forzaId)
      expect(refused.status).toBe(BAD_REQUEST)
      expect(codeOf(refused.body)).toBe(ErrorCodes.SHIPPING_CARRIER_REJECTED)
      expect(metaOf(refused.body).carrierMessage).toBe('The fake carrier refused the shipment')
      const failed = await read(metaOf(refused.body).shipmentId ?? '')
      expect(failed).toMatchObject({
        status: ShipmentStatus.FAILED,
        guideNumber: null,
        lastError: 'The fake carrier refused the shipment'
      })
      standalone.state.create = FakeCarrierBehaviors.OK
      const retried = await ship(order.id, forzaId)
      expect(retried.status).toBe(CREATED)
      // A new attempt has its own key
      const keys = (await shipmentsOf(order.id)).map(row => row.idempotencyKey)
      expect(new Set(keys).size).toBe(2)
      expect(keys[1]).toMatch(/:2$/)
    })
  })

  describe('an outcome nobody knows', () => {
    it('never makes a second guide: the carrier acted, the answer was lost', async () => {
      const order = await confirmed()
      standalone.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      const first = await ship(order.id, forzaId)
      expect(first.status).toBe(CONFLICT)
      expect(codeOf(first.body)).toBe(ErrorCodes.SHIPPING_OUTCOME_UNKNOWN)
      const reviewId = metaOf(first.body).shipmentId ?? ''
      expect(await read(reviewId)).toMatchObject({
        status: ShipmentStatus.REQUIRES_REVIEW,
        lastError: 'unknown_outcome',
        guideNumber: null
      })

      standalone.state.create = FakeCarrierBehaviors.OK
      const second = await ship(order.id, forzaId)
      expect(second.status).toBe(CONFLICT)
      expect(codeOf(second.body)).toBe(ErrorCodes.SHIPPING_OUTCOME_UNKNOWN)
      // One call, one guide at the carrier, one row: the retry never reached the carrier
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
      expect(standalone.state.guides.size).toBe(1)
      expect(await shipmentsOf(order.id)).toHaveLength(1)
    })

    it('finds the guide again by the order number when the agent checks with the carrier', async () => {
      const order = await confirmed()
      standalone.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      const reviewId = metaOf((await ship(order.id, forzaId)).body).shipmentId ?? ''
      const checked = await asAdmin().post(ApiRoutes.shipments.check(reviewId))
      expect(checked.status).toBe(OK)
      const { found, shipment } = checked.body as { found: boolean; shipment: ShipmentBody }
      expect(found).toBe(true)
      expect(shipment.status).toBe(ShipmentStatus.LABEL_CREATED)
      expect(shipment.guideNumber).toBe([...standalone.state.guides.keys()][0])
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
    })

    it('says the guide was not found when the carrier made none (the call never arrived)', async () => {
      const order = await confirmed()
      standalone.state.create = FakeCarrierBehaviors.TIMEOUT_BEFORE
      const reviewId = metaOf((await ship(order.id, forzaId)).body).shipmentId ?? ''
      const checked = await asAdmin().post(ApiRoutes.shipments.check(reviewId))
      expect(checked.body).toMatchObject({
        found: false,
        shipment: { status: ShipmentStatus.REQUIRES_REVIEW }
      })
      // The agent decides it failed, and a new guide is allowed
      const failed = await asAdmin()
        .post(ApiRoutes.shipments.status(reviewId))
        .send({ status: ShipmentStatus.FAILED })
      expect(failed.status).toBe(OK)
      standalone.state.create = FakeCarrierBehaviors.OK
      expect((await ship(order.id, forzaId)).status).toBe(CREATED)
    })

    it('lets the agent record a guide found outside the platform, with its number', async () => {
      const order = await confirmed()
      standalone.state.create = FakeCarrierBehaviors.TIMEOUT_BEFORE
      const reviewId = metaOf((await ship(order.id, forzaId)).body).shipmentId ?? ''
      const withoutNumber = await asAdmin()
        .post(ApiRoutes.shipments.status(reviewId))
        .send({ status: ShipmentStatus.LABEL_CREATED })
      expect(withoutNumber.status).toBe(BAD_REQUEST)
      const recorded = await asAdmin()
        .post(ApiRoutes.shipments.status(reviewId))
        .send({ status: ShipmentStatus.LABEL_CREATED, guideNumber: 'BY-HAND-1' })
      expect(recorded.status).toBe(OK)
      expect(recorded.body).toMatchObject({
        status: ShipmentStatus.LABEL_CREATED,
        guideNumber: 'BY-HAND-1'
      })
    })

    it('does not let an agent settle a guide that is still being made', async () => {
      const order = await confirmed()
      const row = await owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: order.id,
          connectionId: forzaId,
          serviceCode: 'local',
          shippingPayer: ShippingPayer.SENDER,
          currency: 'USD',
          idempotencyKey: `${prefix}-in-flight-${(counter += 1)}`,
          createdBy: 'system'
        }
      })
      const response = await asAdmin()
        .post(ApiRoutes.shipments.status(row.id))
        .send({ status: ShipmentStatus.FAILED })
      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION)
    })

    it('is checked only while it waits for review', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, forzaId)).body as ShipmentBody
      const checked = await asAdmin().post(ApiRoutes.shipments.check(body.id))
      expect(checked.status).toBe(CONFLICT)
      expect(codeOf(checked.body)).toBe(ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION)
    })
  })

  describe('the status of a shipment, set by hand', () => {
    it('goes forward through the table, counts the failed attempts and keeps the history', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      const set = (status: ShipmentStatus, extra: Record<string, unknown> = {}) =>
        asAdmin()
          .post(ApiRoutes.shipments.status(body.id))
          .send({ status, ...extra })
      expect((await set(ShipmentStatus.PICKED_UP)).status).toBe(OK)
      expect((await set(ShipmentStatus.OUT_FOR_DELIVERY)).status).toBe(OK)
      const attempt1 = await set(ShipmentStatus.FAILED_ATTEMPT, { description: 'Nobody home' })
      expect(attempt1.body).toMatchObject({
        status: ShipmentStatus.FAILED_ATTEMPT,
        failedAttempts: 1
      })
      // A repeated attempt goes to itself and counts again
      const attempt2 = await set(ShipmentStatus.FAILED_ATTEMPT)
      expect(attempt2.body).toMatchObject({ failedAttempts: 2 })
      expect((await set(ShipmentStatus.DELIVERED)).body).toMatchObject({
        status: ShipmentStatus.DELIVERED
      })
      const detail = (await asAdmin().get(ApiRoutes.shipments.byId(body.id))).body as {
        events: { status: string; source: string; description: string | null }[]
      }
      expect(detail.events.map(event => event.status).reverse()).toEqual([
        ShipmentStatus.CREATING,
        ShipmentStatus.LABEL_CREATED,
        ShipmentStatus.PICKED_UP,
        ShipmentStatus.OUT_FOR_DELIVERY,
        ShipmentStatus.FAILED_ATTEMPT,
        ShipmentStatus.FAILED_ATTEMPT,
        ShipmentStatus.DELIVERED
      ])
      expect(detail.events.filter(event => event.source === 'manual')).toHaveLength(5)
      const entries = await waitForAuditEntries(
        owner,
        {
          storeId: ctx.storeA.id,
          action: AuditAction.SHIPMENT_STATUS_SET_MANUALLY,
          resourceId: body.id
        },
        5
      )
      expect(entries).toHaveLength(5)
    })

    it('counts a failed attempt sent twice with the same moment once, and a new moment again', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      const set = (status: ShipmentStatus, extra: Record<string, unknown> = {}) =>
        asAdmin()
          .post(ApiRoutes.shipments.status(body.id))
          .send({ status, ...extra })
      expect((await set(ShipmentStatus.PICKED_UP)).status).toBe(OK)
      expect((await set(ShipmentStatus.OUT_FOR_DELIVERY)).status).toBe(OK)
      // After the guide was made and not in the future: the api refuses both
      const moment = new Date(Date.now() - 2).toISOString()
      const first = await set(ShipmentStatus.FAILED_ATTEMPT, { occurredAt: moment })
      expect(first.body).toMatchObject({ failedAttempts: 1 })
      // The same request again (a double click, a retry) is the same event: it changes nothing
      const again = await set(ShipmentStatus.FAILED_ATTEMPT, { occurredAt: moment })
      expect(again.status).toBe(OK)
      expect(again.body).toMatchObject({ failedAttempts: 1 })
      // Another moment is another attempt
      const later = await set(ShipmentStatus.FAILED_ATTEMPT, {
        occurredAt: new Date().toISOString()
      })
      expect(later.body).toMatchObject({ failedAttempts: 2 })
      const detail = (await asAdmin().get(ApiRoutes.shipments.byId(body.id))).body as {
        events: { status: string }[]
      }
      expect(
        detail.events.filter(event => event.status === String(ShipmentStatus.FAILED_ATTEMPT))
      ).toHaveLength(2)
    })

    it('never goes backwards, nor sideways where the table has no arrow', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      const set = (status: ShipmentStatus) =>
        asAdmin().post(ApiRoutes.shipments.status(body.id)).send({ status })
      expect((await set(ShipmentStatus.DELIVERED)).status).toBe(OK)
      for (const status of [
        ShipmentStatus.PICKED_UP,
        ShipmentStatus.LABEL_CREATED,
        ShipmentStatus.RETURNED
      ]) {
        const refused = await set(status)
        expect(refused.status).toBe(CONFLICT)
        expect(codeOf(refused.body)).toBe(ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION)
      }
      expect((await read(body.id)).status).toBe(ShipmentStatus.DELIVERED)
    })

    it('refuses a status the platform decides for itself', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      for (const status of [ShipmentStatus.CREATING, ShipmentStatus.CANCELLED, 'nonsense']) {
        const response = await asAdmin().post(ApiRoutes.shipments.status(body.id)).send({ status })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('lets the order be shipped again after the package came back', async () => {
      const order = await confirmed()
      const first = (await ship(order.id, localId)).body as ShipmentBody
      for (const status of [ShipmentStatus.PICKED_UP, ShipmentStatus.RETURNED]) {
        await asAdmin().post(ApiRoutes.shipments.status(first.id)).send({ status })
      }
      const again = await ship(order.id, localId)
      expect(again.status).toBe(CREATED)
      expect(await shipmentsOf(order.id)).toHaveLength(2)
    })
  })

  describe('cancelling and voiding a guide', () => {
    it('asks a carrier that can void the guide, and records the refund it reports', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, forzaId)).body as ShipmentBody
      const cancelled = await asAdmin().post(ApiRoutes.shipments.cancel(body.id))
      expect(cancelled.status).toBe(OK)
      // The request only starts the void: the carrier is asked by the job, never inside the request
      expect(cancelled.body).toMatchObject({ status: ShipmentStatus.CANCEL_PENDING })
      expect(standalone.callsTo('cancelShipment')).toHaveLength(0)
      expect(await settleVoid(body.id)).toBe(VoidSettlements.CANCELLED)
      expect(await read(body.id)).toMatchObject({
        status: ShipmentStatus.CANCELLED,
        refundStatus: GuideRefundStatus.PENDING
      })
      expect(standalone.callsTo('cancelShipment')).toHaveLength(1)
      expect(standalone.state.guides.get(body.guideNumber ?? '')?.voided).toBe(true)
    })

    it('leaves the guide cancel-failed when the carrier refuses, and lets the agent mark it voided', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, forzaId)).body as ShipmentBody
      standalone.state.cancel = FakeCarrierBehaviors.REJECT
      await asAdmin().post(ApiRoutes.shipments.cancel(body.id))
      expect(await settleVoid(body.id)).toBe(VoidSettlements.FAILED)
      expect(await read(body.id)).toMatchObject({
        status: ShipmentStatus.CANCEL_FAILED,
        lastError: 'The fake carrier refused to void the guide'
      })
      // While it is not voided the order holds it: no second guide
      expect(codeOf((await ship(order.id, forzaId)).body)).toBe(
        ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS
      )
      const voided = await asAdmin().post(ApiRoutes.shipments.markVoided(body.id))
      expect(voided.status).toBe(OK)
      expect(voided.body).toMatchObject({ status: ShipmentStatus.CANCELLED })
      expect((await ship(order.id, forzaId)).status).toBe(CREATED)
    })

    it('does not mark as voided a guide that is not being voided', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, forzaId)).body as ShipmentBody
      const refused = await asAdmin().post(ApiRoutes.shipments.markVoided(body.id))
      expect(refused.status).toBe(CONFLICT)
      expect(codeOf(refused.body)).toBe(ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION)
    })

    it('refuses to cancel a guide whose package has left, or whose outcome is unknown', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      await asAdmin()
        .post(ApiRoutes.shipments.status(body.id))
        .send({ status: ShipmentStatus.PICKED_UP })
      const left = await asAdmin().post(ApiRoutes.shipments.cancel(body.id))
      expect(left.status).toBe(CONFLICT)
      expect(codeOf(left.body)).toBe(ErrorCodes.SHIPPING_CANNOT_CANCEL_AFTER_PICKUP)

      const unknown = await confirmed()
      standalone.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      const reviewId = metaOf((await ship(unknown.id, forzaId)).body).shipmentId ?? ''
      const refused = await asAdmin().post(ApiRoutes.shipments.cancel(reviewId))
      expect(codeOf(refused.body)).toBe(ErrorCodes.SHIPPING_OUTCOME_UNKNOWN)
    })

    it('does not hold the order for a guide that is only a label: the order is cancelled and the guide is voided with it', async () => {
      const order = await confirmed()
      // What a confirmed order holds: its unit reserved in the warehouse it leaves from
      await owner.inventoryLevel.create({
        data: {
          storeId: ctx.storeA.id,
          productId: order.productId,
          warehouseId: ctx.warehouseA.id,
          onHand: 5,
          reserved: 1
        }
      })
      const body = (await ship(order.id, localId)).body as ShipmentBody
      const cancelled = await asAdmin().post(ApiRoutes.orders.status(order.id)).send({
        status: 'CANCELLED',
        cancellationReason: OrderCancellationReasons.CUSTOMER_REQUEST
      })
      expect(cancelled.status).toBe(OK)
      expect(await read(body.id)).toMatchObject({ status: ShipmentStatus.CANCELLED })
    })
  })

  describe('what the review of the engine found', () => {
    it('replaces the tracking number of a voided guide with the number of the next one, and leaves one an agent typed', async () => {
      const order = await confirmed()
      const first = (await ship(order.id, localId)).body as ShipmentBody
      await asAdmin().post(ApiRoutes.shipments.cancel(first.id))
      const second = (await ship(order.id, localId)).body as ShipmentBody
      expect(
        (await owner.order.findUniqueOrThrow({ where: { id: order.id } })).trackingNumber
      ).toBe(second.guideNumber)
      // A number typed by hand is not the engine's to replace
      const typed = await confirmed()
      await owner.order.update({ where: { id: typed.id }, data: { trackingNumber: 'MINE-9' } })
      await ship(typed.id, localId)
      expect(
        (await owner.order.findUniqueOrThrow({ where: { id: typed.id } })).trackingNumber
      ).toBe('MINE-9')
    })

    it('does not call the carrier a second time for a guide that is already being cancelled', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, forzaId)).body as ShipmentBody
      standalone.state.cancel = FakeCarrierBehaviors.TIMEOUT_BEFORE
      const started = await asAdmin().post(ApiRoutes.shipments.cancel(body.id))
      expect(started.body).toMatchObject({ status: ShipmentStatus.CANCEL_PENDING })
      // The carrier did not answer: the queue is asked to try again, and the guide stays pending while it does
      expect(await settleVoid(body.id)).toBe(VoidSettlements.RETRY)
      expect((await read(body.id)).status).toBe(ShipmentStatus.CANCEL_PENDING)
      const calls = standalone.callsTo('cancelShipment').length
      const again = await asAdmin().post(ApiRoutes.shipments.cancel(body.id))
      expect(again.status).toBe(CONFLICT)
      expect(standalone.callsTo('cancelShipment')).toHaveLength(calls)
      // The last attempt gives up: the guide is cancel-failed for an agent to settle
      expect(await settleVoid(body.id, true)).toBe(VoidSettlements.FAILED)
      expect(await read(body.id)).toMatchObject({
        status: ShipmentStatus.CANCEL_FAILED,
        lastError: 'unknown_outcome'
      })
    })

    it('keeps the guide made when the label cannot be stored: the guide is recorded without it', async () => {
      const order = await confirmed()
      const spy = jest.spyOn(storage, 'put').mockRejectedValueOnce(new Error('bucket down'))
      try {
        const response = await ship(order.id, forzaId)
        expect(response.status).toBe(CREATED)
        expect(response.body).toMatchObject({
          status: ShipmentStatus.LABEL_CREATED,
          hasLabel: false,
          lastError: 'label_invalid'
        })
      } finally {
        spy.mockRestore()
      }
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
    })

    it('puts a guide the platform could not record in review with the guide on the row', async () => {
      const order = await confirmed()
      const first = (await ship(order.id, forzaId)).body as ShipmentBody
      // The next order gets the same guide number from the carrier: the table refuses it (one number per connection)
      const clash = await confirmed()
      const original = standalone.plugin.createShipment?.bind(standalone.plugin)
      Object.assign(standalone.plugin, {
        createShipment: async (...args: Parameters<NonNullable<typeof original>>) => {
          const result = await (original as NonNullable<typeof original>)(...args)
          return { ...result, guideNumber: first.guideNumber ?? result.guideNumber }
        }
      })
      try {
        const refused = await ship(clash.id, forzaId)
        expect(refused.status).toBe(CONFLICT)
        expect(codeOf(refused.body)).toBe(ErrorCodes.SHIPPING_GUIDE_NUMBER_TAKEN)
        const row = await read(metaOf(refused.body).shipmentId ?? '')
        expect(row.status).toBe(ShipmentStatus.REQUIRES_REVIEW)
      } finally {
        Object.assign(standalone.plugin, { createShipment: original })
      }
    })

    it('does not trust a pickup batch whose entry is garbled: that shipment goes to review, the others are recorded', async () => {
      const orders = await Promise.all([confirmed(), confirmed()])
      const original = pickupBound.plugin.createShipmentsWithPickup?.bind(pickupBound.plugin)
      Object.assign(pickupBound.plugin, {
        createShipmentsWithPickup: async (...args: Parameters<NonNullable<typeof original>>) => {
          const answer = await (original as NonNullable<typeof original>)(...args)
          return { ...answer, shipments: [answer.shipments[0], null] }
        }
      })
      try {
        const outcomes = await service.createShipments(
          ctx.storeA.id,
          orders.map(order => ({ orderId: order.id, connectionId: c807Id })),
          { actor: { type: 'user', id: ctx.adminA.id }, canOverridePrice: false },
          id => app.get(CarrierRegistry, { strict: false }).find(id)
        )
        expect(outcomes[0]?.ok).toBe(true)
        expect(outcomes[1]?.ok).toBe(false)
        const [good] = await shipmentsOf(orders[0]?.id ?? '')
        const [garbled] = await shipmentsOf(orders[1]?.id ?? '')
        expect(good?.status).toBe(ShipmentStatus.LABEL_CREATED)
        expect(garbled?.status).toBe(ShipmentStatus.REQUIRES_REVIEW)
      } finally {
        Object.assign(pickupBound.plugin, { createShipmentsWithPickup: original })
      }
    })

    it('adds the shipping fee of a split cash-on-delivery order once, also inside one batch', async () => {
      const split = await confirmed({
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        shippingCents: 200
      })
      const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: split.id } })
      const second = await owner.orderItem.create({
        data: {
          orderId: split.id,
          productId: item.productId,
          productName: 'second line',
          quantity: 1,
          unitPriceCents: 1000
        }
      })
      await owner.orderItemAllocation.create({
        data: {
          storeId: ctx.storeA.id,
          orderItemId: second.id,
          warehouseId: ctx.warehouseASecond.id,
          quantity: 1
        }
      })
      await owner.warehouse.update({
        where: { id: ctx.warehouseASecond.id },
        data: { address: { line1: 'Bodega 2', city: 'Santa Tecla', country: 'SV' } }
      })
      await owner.order.update({
        where: { id: split.id },
        data: { subtotalCents: 2999, totalCents: 3199 }
      })
      const outcomes = await service.createShipments(
        ctx.storeA.id,
        [ctx.warehouseA.id, ctx.warehouseASecond.id].map(originWarehouseId => ({
          orderId: split.id,
          connectionId: c807Id,
          originWarehouseId
        })),
        { actor: { type: 'user', id: ctx.adminA.id }, canOverridePrice: false },
        id => app.get(CarrierRegistry, { strict: false }).find(id)
      )
      expect(outcomes.every(outcome => outcome.ok)).toBe(true)
      const rows = await shipmentsOf(split.id)
      expect(rows.reduce((sum, row) => sum + (row.codAmountCents ?? 0), 0)).toBe(3199)
    })

    it('sends a guide to review when the plugin answers with nothing readable, and keeps the other outcomes of the batch', async () => {
      const orders = await Promise.all([confirmed(), confirmed()])
      const original = standalone.plugin.createShipment?.bind(standalone.plugin)
      let calls = 0
      Object.assign(standalone.plugin, {
        createShipment: (...args: Parameters<NonNullable<typeof original>>) => {
          calls += 1
          return calls === 1
            ? (original as NonNullable<typeof original>)(...args)
            : Promise.resolve(undefined)
        }
      })
      try {
        const outcomes = await service.createShipments(
          ctx.storeA.id,
          orders.map(order => ({ orderId: order.id, connectionId: forzaId })),
          { actor: { type: 'user', id: ctx.adminA.id }, canOverridePrice: false },
          id => app.get(CarrierRegistry, { strict: false }).find(id)
        )
        expect(outcomes[0]?.ok).toBe(true)
        expect(outcomes[1]?.ok).toBe(false)
        const [bad] = await shipmentsOf(orders[1]?.id ?? '')
        expect(bad?.status).toBe(ShipmentStatus.REQUIRES_REVIEW)
      } finally {
        Object.assign(standalone.plugin, { createShipment: original })
      }
    })

    it('does not adopt, when checking with the carrier, a guide another shipment of the connection already holds', async () => {
      const split = await confirmed()
      const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: split.id } })
      const second = await owner.orderItem.create({
        data: {
          orderId: split.id,
          productId: item.productId,
          productName: 'second line',
          quantity: 1,
          unitPriceCents: 500
        }
      })
      await owner.orderItemAllocation.create({
        data: {
          storeId: ctx.storeA.id,
          orderItemId: second.id,
          warehouseId: ctx.warehouseASecond.id,
          quantity: 1
        }
      })
      await owner.warehouse.update({
        where: { id: ctx.warehouseASecond.id },
        data: { address: { line1: 'Bodega 2', city: 'Santa Tecla', country: 'SV' } }
      })
      const a = (await ship(split.id, forzaId, { originWarehouseId: ctx.warehouseA.id }))
        .body as ShipmentBody
      standalone.state.create = FakeCarrierBehaviors.TIMEOUT_BEFORE
      const review = await ship(split.id, forzaId, { originWarehouseId: ctx.warehouseASecond.id })
      const reviewId = metaOf(review.body).shipmentId ?? ''
      const checked = await asAdmin().post(ApiRoutes.shipments.check(reviewId))
      expect(checked.body).toMatchObject({ found: false })
      expect((await read(a.id)).status).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('lets a cancel that nobody is making be asked again after a while, and not before', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, forzaId)).body as ShipmentBody
      await owner.shipment.update({
        where: { id: body.id },
        data: { status: ShipmentStatus.CANCEL_PENDING, cancelRequestedAt: new Date() }
      })
      expect((await asAdmin().post(ApiRoutes.shipments.cancel(body.id))).status).toBe(CONFLICT)
      await owner.shipment.update({
        where: { id: body.id },
        data: { cancelRequestedAt: new Date(Date.now() - 20 * 60 * 1000) }
      })
      const again = await asAdmin().post(ApiRoutes.shipments.cancel(body.id))
      expect(again.status).toBe(OK)
      expect(again.body).toMatchObject({ status: ShipmentStatus.CANCEL_PENDING })
      expect(await settleVoid(body.id)).toBe(VoidSettlements.CANCELLED)
    })

    it('refuses a moment of a manual status in the future or before the guide existed', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      const set = (occurredAt: string) =>
        asAdmin()
          .post(ApiRoutes.shipments.status(body.id))
          .send({ status: ShipmentStatus.PICKED_UP, occurredAt })
      expect((await set('2999-01-01T00:00:00Z')).status).toBe(BAD_REQUEST)
      expect((await set('2000-01-01T00:00:00Z')).status).toBe(BAD_REQUEST)
      expect((await set(new Date().toISOString())).status).toBe(OK)
    })

    it('audits a guide that was refused after it was written, and tells a voided guide from one that failed to be', async () => {
      const order = await confirmed()
      standalone.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      const refused = await ship(order.id, forzaId)
      const reviewId = metaOf(refused.body).shipmentId ?? ''
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.SHIPMENT_CREATED,
        resourceId: reviewId
      })
      expect(entries).toHaveLength(1)
      standalone.state.create = FakeCarrierBehaviors.OK
      const guided = await confirmed()
      const body = (await ship(guided.id, forzaId)).body as ShipmentBody
      standalone.state.cancel = FakeCarrierBehaviors.REJECT
      await asAdmin().post(ApiRoutes.shipments.cancel(body.id))
      const manual = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.SHIPMENT_CANCEL_REQUESTED,
        resourceId: body.id
      })
      expect(manual).toHaveLength(1)
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.SHIPMENT_CANCELLED, resourceId: body.id }
        })
      ).toBe(0)
    })
  })

  describe('the order follows its guide', () => {
    it('refuses a hand-made SHIPPED or DELIVERED while a guide is alive, and allows it without one', async () => {
      const guided = await confirmed({ status: 'PREPARING' })
      expect((await ship(guided.id, localId)).status).toBe(CREATED)
      for (const status of ['SHIPPED', 'DELIVERED']) {
        const refused = await asAdmin().post(ApiRoutes.orders.status(guided.id)).send({ status })
        expect(refused.status).toBe(CONFLICT)
        expect(codeOf(refused.body)).toBe(ErrorCodes.ORDER_STATUS_DRIVEN_BY_SHIPMENT)
      }
      expect((await owner.order.findUniqueOrThrow({ where: { id: guided.id } })).status).toBe(
        'PREPARING'
      )
    })

    it('leaves the tracking number to the guide while it is alive', async () => {
      const order = await confirmed()
      await ship(order.id, localId)
      const edit = await asAdmin()
        .patch(ApiRoutes.orders.byId(order.id))
        .send({ trackingNumber: 'MINE-1' })
      expect(edit.status).toBe(CONFLICT)
      expect(codeOf(edit.body)).toBe(ErrorCodes.ORDER_FIELD_NOT_EDITABLE)
    })
  })

  describe('what an order needs to get a guide', () => {
    it.each([
      [
        'is not confirmed yet',
        { status: 'PENDING_CONFIRMATION' },
        ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED,
        CONFLICT
      ],
      [
        'has a price waiting for approval',
        { priceApprovalStatus: PriceApprovalStatus.PENDING },
        ErrorCodes.ORDER_PRICE_APPROVAL_PENDING,
        CONFLICT
      ],
      [
        'has no phone for the recipient',
        { recipientPhones: [] },
        ErrorCodes.SHIPPING_RECIPIENT_PHONE_MISSING,
        BAD_REQUEST
      ]
    ])('refuses an order that %s', async (_name, over, code, status) => {
      const order = await confirmed(over)
      const response = await ship(order.id, localId)
      expect(response.status).toBe(status)
      expect(codeOf(response.body)).toBe(code)
      expect(await shipmentsOf(order.id)).toHaveLength(0)
    })

    it('refuses an order with no shipping address', async () => {
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: 'CONFIRMED',
        allocatedAt: ctx.warehouseA.id
      })
      const response = await ship(order.id, localId)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_ADDRESS_MISSING)
    })

    it('refuses a carrier that was disconnected, one of another store and one that does not exist', async () => {
      const order = await confirmed()
      const gone = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        prefix: 'LG',
        status: CarrierConnectionStatus.DISABLED
      })
      expect(codeOf((await ship(order.id, gone.id)).body)).toBe(
        ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE
      )
      const other = await createCarrierConnection(owner, { storeId: ctx.storeB.id, prefix: 'LB' })
      expect((await ship(order.id, other.id)).status).toBe(NOT_FOUND)
      expect((await ship(order.id, '00000000-0000-4000-8000-000000000000')).status).toBe(NOT_FOUND)
    })

    it('refuses an order that names no carrier when the store has no default', async () => {
      const order = await confirmed()
      const response = await asAdmin().post(ApiRoutes.shipments.forOrder(order.id)).send({})
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_CARRIER_REQUIRED)
    })

    it('uses the planned carrier of the order, then the default of the store', async () => {
      const planned = await confirmed({ carrierConnectionId: forzaId })
      const viaPlanned = await asAdmin().post(ApiRoutes.shipments.forOrder(planned.id)).send({})
      expect(viaPlanned.status).toBe(CREATED)
      expect(standalone.callsTo('createShipment')).toHaveLength(1)

      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { defaultCarrierConnectionId: localId }
      })
      try {
        const plain = await confirmed()
        const viaDefault = await asAdmin().post(ApiRoutes.shipments.forOrder(plain.id)).send({})
        expect(viaDefault.status).toBe(CREATED)
        expect((viaDefault.body as ShipmentBody).guideNumber).toMatch(/^LA-/)
      } finally {
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { defaultCarrierConnectionId: null }
        })
      }
    })

    it('refuses a service that is not an active one of the carrier', async () => {
      const order = await confirmed()
      const response = await ship(order.id, localId, { serviceCode: 'express' })
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_SERVICE_INVALID)
    })

    it('refuses cash on delivery with a carrier that cannot collect it', async () => {
      const [only] = await Promise.all([
        confirmed({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY })
      ])
      const cod = standalone.plugin.capabilities
      const without = cod.filter(capability => capability !== 'cod')
      const registry = app.get(CarrierRegistry, { strict: false })
      const original = registry.find(CarrierId.FORZA)
      expect(original).toBeDefined()
      Object.assign(standalone.plugin, { capabilities: without })
      try {
        const response = await ship(only.id, forzaId)
        expect(response.status).toBe(CONFLICT)
        expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING)
        expect(standalone.callsTo('createShipment')).toHaveLength(0)
      } finally {
        Object.assign(standalone.plugin, { capabilities: cod })
      }
    })
  })

  describe('the fee of the order against the range of the carrier (TDD_17 §4.13)', () => {
    let rangedId = ''
    let packer: Actor
    const shipAsPacker = (orderId: string, connectionId: string) =>
      api(app, packer, ctx.storeA)
        .post(ApiRoutes.shipments.forOrder(orderId))
        .send({ connectionId })
    beforeAll(async () => {
      // Without ORDERS_OVERRIDE_PRICE (the Admin has it): the range stops this one
      packer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'packer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW, Permissions.SHIPPING_MANAGE]
      })
      rangedId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'LR' })).id
      await owner.carrierConnection.update({
        where: { id: rangedId },
        data: { minShippingFeeCents: 300, maxShippingFeeCents: 600 }
      })
    })

    it('makes the guide when the fee is inside the range', async () => {
      const order = await confirmed({ shippingCents: 500 })
      expect((await shipAsPacker(order.id, rangedId)).status).toBe(CREATED)
    })

    it('refuses a fee outside the range, above and below', async () => {
      for (const shippingCents of [900, 100]) {
        const order = await confirmed({ shippingCents })
        const response = await shipAsPacker(order.id, rangedId)
        expect(response.status).toBe(CONFLICT)
        expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_FEE_OUT_OF_RANGE)
        expect(await shipmentsOf(order.id)).toHaveLength(0)
      }
    })

    it('accepts a free-shipping order with a fee of 0, whatever the minimum', async () => {
      const order = await confirmed({ shippingCents: 0, freeShipping: true })
      expect((await shipAsPacker(order.id, rangedId)).status).toBe(CREATED)
    })

    it('accepts the fee an approver accepted, and refuses it after a rejection', async () => {
      const approved = await confirmed({
        shippingCents: 900,
        priceApprovalStatus: PriceApprovalStatus.APPROVED,
        priceApprovedShippingCents: 900
      })
      expect((await shipAsPacker(approved.id, rangedId)).status).toBe(CREATED)
      const different = await confirmed({
        shippingCents: 950,
        priceApprovalStatus: PriceApprovalStatus.APPROVED,
        priceApprovedShippingCents: 900
      })
      expect(codeOf((await shipAsPacker(different.id, rangedId)).body)).toBe(
        ErrorCodes.SHIPPING_FEE_OUT_OF_RANGE
      )
    })

    it('lets a member who may override prices through', async () => {
      const manager = await actorWithPermissions(owner, app, {
        prefix,
        name: 'manager',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.SHIPPING_VIEW,
          Permissions.SHIPPING_MANAGE,
          Permissions.ORDERS_OVERRIDE_PRICE
        ]
      })
      const order = await confirmed({ shippingCents: 900 })
      const refused = await shipAsPacker(order.id, rangedId)
      expect(refused.status).toBe(CONFLICT)
      const made = await api(app, manager, ctx.storeA)
        .post(ApiRoutes.shipments.forOrder(order.id))
        .send({ connectionId: rangedId })
      expect(made.status).toBe(CREATED)
    })
  })

  describe('a carrier whose guides exist only inside a pickup', () => {
    const batch = async (count: number, window?: { date: string; from: string; to: string }) => {
      const orders = await Promise.all(Array.from({ length: count }, () => confirmed()))
      const outcomes = await service.createShipments(
        ctx.storeA.id,
        orders.map(order => ({
          orderId: order.id,
          connectionId: c807Id,
          ...(window === undefined ? {} : { pickup: window })
        })),
        { actor: { type: 'user', id: ctx.adminA.id }, canOverridePrice: false },
        id => app.get(CarrierRegistry, { strict: false }).find(id)
      )
      return { orders, outcomes }
    }

    it('makes one call with the pickup and every shipment, and attaches each guide to the pickup', async () => {
      const window = { date: '2026-12-01', from: '09:00', to: '12:00' }
      const { orders, outcomes } = await batch(2, window)
      expect(
        outcomes.map(outcome => (outcome.ok ? 'ok' : outcome.error.code + outcome.error.message))
      ).toEqual(['ok', 'ok'])
      const calls = pickupBound.callsTo('createShipmentsWithPickup')
      expect(calls).toHaveLength(1)
      const sent = calls[0]?.args as {
        pickup: { window: unknown; packageCount: number }
        shipments: unknown[]
      }
      expect(sent.pickup).toEqual({ window, packageCount: 2 })
      expect(sent.shipments).toHaveLength(2)
      const rows = (await Promise.all(orders.map(order => shipmentsOf(order.id)))).flat()
      expect(
        rows.every(row => row.status === String(ShipmentStatus.LABEL_CREATED) && row.guideNumber)
      ).toBe(true)
      expect(new Set(rows.map(row => row.pickupId)).size).toBe(1)
      const pickup = await owner.pickupRequest.findUniqueOrThrow({
        where: { id: rows[0]?.pickupId ?? '' }
      })
      expect(pickup).toMatchObject({
        status: PickupStatus.REQUESTED,
        packageCount: 2,
        windowStart: '09:00',
        windowEnd: '12:00'
      })
      expect(pickup.providerPickupId).toMatch(/^FAKE-PICKUP-/)
    })

    it('splits a batch bigger than the carrier takes into more calls', async () => {
      const { outcomes } = await batch(3)
      expect(outcomes.every(outcome => outcome.ok)).toBe(true)
      expect(pickupBound.callsTo('createShipmentsWithPickup')).toHaveLength(2)
    })

    it('takes partial success as normal: the one the carrier refused is failed, the others have guides', async () => {
      const orders = await Promise.all([confirmed(), confirmed()])
      const refusedOrder = await owner.order.findUniqueOrThrow({
        where: { id: orders[1]?.id ?? '' }
      })
      pickupBound.state.rejectReferences.add(refusedOrder.orderNumber)
      const outcomes = await service.createShipments(
        ctx.storeA.id,
        orders.map(order => ({ orderId: order.id, connectionId: c807Id })),
        { actor: { type: 'user', id: ctx.adminA.id }, canOverridePrice: false },
        id => app.get(CarrierRegistry, { strict: false }).find(id)
      )
      expect(outcomes[0]?.ok).toBe(true)
      expect(outcomes[1]?.ok).toBe(false)
      const [good] = await shipmentsOf(orders[0]?.id ?? '')
      const [bad] = await shipmentsOf(orders[1]?.id ?? '')
      expect(good).toMatchObject({ status: ShipmentStatus.LABEL_CREATED })
      expect(bad).toMatchObject({ status: ShipmentStatus.FAILED, pickupId: null })
      expect(bad?.lastError).toContain('refused')
      const pickup = await owner.pickupRequest.findUniqueOrThrow({
        where: { id: good?.pickupId ?? '' }
      })
      expect(pickup).toMatchObject({ status: PickupStatus.REQUESTED, packageCount: 1 })
    })

    it('sends the whole batch to review when the outcome is unknown, and makes no second call', async () => {
      pickupBound.state.create = FakeCarrierBehaviors.TIMEOUT_AFTER
      const { orders, outcomes } = await batch(2)
      expect(outcomes.every(outcome => !outcome.ok)).toBe(true)
      // Each shipment of the batch is named by its own id in the error of its outcome, not by the first one's
      for (const outcome of outcomes) {
        expect(outcome.ok ? null : outcome.error.metadata?.['shipmentId']).toBe(
          outcome.ok ? null : outcome.shipmentId
        )
      }
      const rows = (await Promise.all(orders.map(order => shipmentsOf(order.id)))).flat()
      expect(rows.map(row => row.status)).toEqual([
        ShipmentStatus.REQUIRES_REVIEW,
        ShipmentStatus.REQUIRES_REVIEW
      ])
      const pickup = await owner.pickupRequest.findUniqueOrThrow({
        where: { id: rows[0]?.pickupId ?? '' }
      })
      expect(pickup.status).toBe(PickupStatus.REQUIRES_REVIEW)
      expect(pickupBound.callsTo('createShipmentsWithPickup')).toHaveLength(1)
      // The orders are held: a retry makes no guide
      pickupBound.state.create = FakeCarrierBehaviors.OK
      const again = await service.createShipments(
        ctx.storeA.id,
        orders.map(order => ({ orderId: order.id, connectionId: c807Id })),
        { actor: { type: 'user', id: ctx.adminA.id }, canOverridePrice: false },
        id => app.get(CarrierRegistry, { strict: false }).find(id)
      )
      expect(again.every(outcome => !outcome.ok)).toBe(true)
      expect(pickupBound.callsTo('createShipmentsWithPickup')).toHaveLength(1)
      expect(pickupBound.state.guides.size).toBe(2)
    })

    it('refuses the orders that cannot ship without stopping the ones that can', async () => {
      const good = await confirmed()
      const bad = await confirmed({ status: 'PENDING_CONFIRMATION' })
      const outcomes = await service.createShipments(
        ctx.storeA.id,
        [good, bad].map(order => ({ orderId: order.id, connectionId: c807Id })),
        { actor: { type: 'user', id: ctx.adminA.id }, canOverridePrice: false },
        id => app.get(CarrierRegistry, { strict: false }).find(id)
      )
      expect(outcomes[0]?.ok).toBe(true)
      expect(outcomes[1]).toMatchObject({ ok: false })
      expect(pickupBound.callsTo('createShipmentsWithPickup')).toHaveLength(1)
    })
  })

  describe('cash on delivery with several origins', () => {
    it('splits the total between the guides so that they add up to it exactly', async () => {
      const customerOrder = await confirmed({
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        shippingCents: 200
      })
      // The same order has a second line from the second warehouse
      const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: customerOrder.id } })
      const second = await owner.orderItem.create({
        data: {
          orderId: customerOrder.id,
          productId: item.productId,
          productName: 'second line',
          quantity: 1,
          unitPriceCents: 1000
        }
      })
      await owner.orderItemAllocation.create({
        data: {
          storeId: ctx.storeA.id,
          orderItemId: second.id,
          warehouseId: ctx.warehouseASecond.id,
          quantity: 1
        }
      })
      await owner.warehouse.update({
        where: { id: ctx.warehouseASecond.id },
        data: { address: { line1: 'Bodega 2', city: 'Santa Tecla', country: 'SV' } }
      })
      await owner.order.update({
        where: { id: customerOrder.id },
        data: { subtotalCents: 2999, totalCents: 3199 }
      })
      // Two origins and no origin named: the engine does not guess
      const unclear = await ship(customerOrder.id, localId)
      expect(unclear.status).toBe(BAD_REQUEST)
      expect(codeOf(unclear.body)).toBe(ErrorCodes.SHIPPING_ORIGIN_MISSING)
      const first = (
        await ship(customerOrder.id, localId, { originWarehouseId: ctx.warehouseA.id })
      ).body as ShipmentBody
      const last = (
        await ship(customerOrder.id, localId, { originWarehouseId: ctx.warehouseASecond.id })
      ).body as ShipmentBody
      expect((first.codAmountCents ?? 0) + (last.codAmountCents ?? 0)).toBe(3199)
      // The fee goes on the first guide made
      expect(first.codAmountCents).toBe(1999 + 200)
      expect(last.codAmountCents).toBe(1000)
    })
  })

  describe('who may do what', () => {
    it('lets a viewer read the shipments and nothing else', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      const viewer = () => api(app, ctx.viewerA, ctx.storeA)
      expect((await viewer().get(ApiRoutes.shipments.list)).status).toBe(OK)
      expect((await viewer().get(ApiRoutes.shipments.byId(body.id))).status).toBe(OK)
      const writes = [
        viewer().post(ApiRoutes.shipments.forOrder(order.id)).send({ connectionId: localId }),
        viewer().get(ApiRoutes.shipments.label(body.id)),
        viewer()
          .post(ApiRoutes.shipments.status(body.id))
          .send({ status: ShipmentStatus.PICKED_UP }),
        viewer().post(ApiRoutes.shipments.cancel(body.id)),
        viewer().post(ApiRoutes.shipments.check(body.id)),
        viewer().post(ApiRoutes.shipments.markVoided(body.id))
      ]
      for (const response of await Promise.all(writes)) expect(response.status).toBe(FORBIDDEN)
    })

    it('lists the shipments of the store with their filters and pages', async () => {
      const order = await confirmed()
      const made = (await ship(order.id, localId)).body as ShipmentBody
      const filtered = await asAdmin().get(ApiRoutes.shipments.list).query({ orderId: order.id })
      expect((filtered.body as { data: ShipmentBody[] }).data.map(row => row.id)).toEqual([made.id])
      const none = await asAdmin()
        .get(ApiRoutes.shipments.list)
        .query({ orderId: order.id, status: ShipmentStatus.DELIVERED })
      expect((none.body as { data: unknown[] }).data).toEqual([])
      const page = await asAdmin().get(ApiRoutes.shipments.list).query({ limit: 2 })
      const first = page.body as {
        data: ShipmentBody[]
        nextCursor: string | null
        hasMore: boolean
      }
      expect(first.data).toHaveLength(2)
      expect(first.hasMore).toBe(true)
      const next = await asAdmin()
        .get(ApiRoutes.shipments.list)
        .query({ limit: 2, cursor: first.nextCursor })
      const ids = [...first.data, ...(next.body as { data: ShipmentBody[] }).data].map(
        row => row.id
      )
      expect(new Set(ids).size).toBe(ids.length)
      expect((await asAdmin().get(ApiRoutes.shipments.list).query({ cursor: 'junk' })).status).toBe(
        BAD_REQUEST
      )
    })

    it('does not show a store the shipments of another, nor let it touch them', async () => {
      const order = await confirmed()
      const body = (await ship(order.id, localId)).body as ShipmentBody
      const asB = () => api(app, ctx.adminB, ctx.storeB)
      expect((await asB().get(ApiRoutes.shipments.byId(body.id))).status).toBe(NOT_FOUND)
      expect((await asB().get(ApiRoutes.shipments.label(body.id))).status).toBe(NOT_FOUND)
      expect(
        (
          await asB()
            .post(ApiRoutes.shipments.status(body.id))
            .send({ status: ShipmentStatus.PICKED_UP })
        ).status
      ).toBe(NOT_FOUND)
      expect((await asB().post(ApiRoutes.shipments.cancel(body.id))).status).toBe(NOT_FOUND)
      expect((await asB().post(ApiRoutes.shipments.check(body.id))).status).toBe(NOT_FOUND)
      expect((await asB().post(ApiRoutes.shipments.markVoided(body.id))).status).toBe(NOT_FOUND)
      expect(
        (await asB().post(ApiRoutes.shipments.forOrder(order.id)).send({ connectionId: localId }))
          .status
      ).toBe(NOT_FOUND)
      const listed = await asB().get(ApiRoutes.shipments.list)
      expect((listed.body as { data: ShipmentBody[] }).data.map(row => row.id)).not.toContain(
        body.id
      )
      expect((await read(body.id)).status).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('refuses a body that names the store, an amount or a status of its own', async () => {
      const order = await confirmed()
      for (const extra of [
        { storeId: ctx.storeB.id },
        { codAmountCents: 1 },
        { status: ShipmentStatus.DELIVERED },
        { guideNumber: 'MINE-1' }
      ]) {
        const response = await ship(order.id, localId, extra)
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect(await shipmentsOf(order.id)).toHaveLength(0)
    })
  })
})
