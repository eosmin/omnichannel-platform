import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  PickupFailureNotes,
  PickupStatus,
  PickupWaitReasons,
  ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { NotificationTypes } from '@platform/core/notifications'
import { JobNames, QueueNames, type SyncPickupJob } from '@platform/core/queues'
import { PickupSync, PickupSyncOutcomes, ShipmentCancellation } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import {
  buildFakeCarrier,
  createCarrierConnection,
  createGuideOn,
  createInventoryLevel,
  createOrder,
  type FakeCarrier,
  FakeCarrierBehaviors
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import type { CapturedQueue } from '../helpers/queue'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const ATTEMPTS = 80
const POLL_MS = 100

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
interface RequestBody {
  pickup: { id: string; status: PickupStatus; packageCount: number; revision: number }
  created: boolean
  joined: string[]
  waiting: { shipmentId: string; reason: string }[]
}

describe('Pickups (TDD_17 §4.10)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let registry: CarrierRegistry
  let sync: PickupSync
  let cancellation: ShipmentCancellation
  let queue: CapturedQueue
  // A carrier that takes, changes and cancels pickups; one that only takes them; the `local` one that has no pickup API
  let full: FakeCarrier
  let requestOnly: FakeCarrier
  let localId = ''
  let fullId = ''
  let requestOnlyId = ''
  const services = new Map<string, string>()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(CarrierRegistry, { strict: false })
    sync = app.get(PickupSync, { strict: false })
    cancellation = app.get(ShipmentCancellation, { strict: false })
    queue = app.get<CapturedQueue>(getQueueToken(QueueNames.HEAVY_PROCESSING), { strict: false })
    full = buildFakeCarrier({
      id: CarrierId.FORZA,
      cancel: true,
      pickupRequest: true,
      pickupModify: true,
      pickupCancel: true
    })
    requestOnly = buildFakeCarrier({ id: CarrierId.C807, cancel: true, pickupRequest: true })
    registry.register(full.plugin)
    registry.register(requestOnly.plugin)
    const make = async (carrierId?: (typeof CarrierId)[keyof typeof CarrierId]) => {
      const built = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        ...(carrierId === undefined ? { prefix: 'PK' } : { carrierId })
      })
      services.set(built.id, built.serviceCode)
      return built.id
    }
    localId = await make()
    fullId = await make(CarrierId.FORZA)
    requestOnlyId = await make(CarrierId.C807)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    for (const fake of [full, requestOnly]) {
      fake.state.guides.clear()
      fake.state.pickups.clear()
      fake.state.calls.length = 0
      fake.state.pickup = FakeCarrierBehaviors.OK
      fake.state.cancel = FakeCarrierBehaviors.OK
    }
    queue.jobs.length = 0
    // Every day of the week, no cutoff: today is always a valid pickup day unless a case says otherwise
    await owner.carrierConnection.updateMany({
      where: { id: { in: [localId, fullId, requestOnlyId] } },
      data: { pickupEnabled: true, pickupDays: [1, 2, 3, 4, 5, 6, 7], pickupCutoffTime: null }
    })
    // Nothing is left over from an earlier case: the guides go, the pickups are over
    await owner.shipment.updateMany({
      where: { connectionId: { in: [localId, fullId, requestOnlyId] } },
      data: { pickupId: null, status: ShipmentStatus.CANCELLED }
    })
    await owner.pickupRequest.updateMany({
      where: { connectionId: { in: [localId, fullId, requestOnlyId] } },
      data: { status: PickupStatus.CANCELLED }
    })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const guideOn = (connectionId: string, packageCount = 1) =>
    createGuideOn(owner, {
      storeId: ctx.storeA.id,
      connectionId,
      serviceCode: services.get(connectionId) ?? 'local',
      packageCount
    })
  const request = (body: Record<string, unknown>) =>
    asAdmin().post(ApiRoutes.pickups.create).send(body)
  const pickupRow = (id: string) => owner.pickupRequest.findUniqueOrThrow({ where: { id } })
  const shipmentRow = (id: string) => owner.shipment.findUniqueOrThrow({ where: { id } })
  const syncJobs = () => queue.jobs.filter(job => job.name === JobNames.SYNC_PICKUP)
  const runSync = (pickupId: string, lastAttempt = false) =>
    sync.run(ctx.storeA.id, pickupId, carrierId => registry.find(carrierId), lastAttempt)
  const notices = (pickupId: string) =>
    owner.notification.findMany({
      where: { resourceId: pickupId, type: NotificationTypes.PICKUP_MANUAL_REQUIRED }
    })

  describe('a carrier with no pickup API', () => {
    it('makes a manual pickup of every waiting guide, tells the team once, prints the manifest and is confirmed by hand', async () => {
      const first = await guideOn(localId)
      const second = await guideOn(localId, 2)

      const made = await request({ connectionId: localId })

      expect(made.status).toBe(CREATED)
      const body = made.body as RequestBody
      expect(body).toMatchObject({
        created: true,
        pickup: { status: PickupStatus.MANUAL_REQUIRED, packageCount: 3 }
      })
      expect([...body.joined].sort()).toEqual([first.id, second.id].sort())
      expect((await shipmentRow(first.id)).pickupId).toBe(body.pickup.id)
      // The carrier is not asked: nothing to ask
      expect(syncJobs()).toHaveLength(0)
      const told = await until(
        () => notices(body.pickup.id),
        rows => rows.length > 0
      )
      expect(new Set(told.map(row => row.userId)).size).toBe(told.length)

      const manifest = await asAdmin().get(ApiRoutes.pickups.manifest(body.pickup.id))
      expect(manifest.status).toBe(OK)
      const lines = (manifest.body as { lines: { guideNumber: string; packageCount: number }[] })
        .lines
      expect(lines.map(line => line.guideNumber).sort()).toEqual(
        [first.guideNumber, second.guideNumber].sort()
      )
      expect(lines.reduce((sum, line) => sum + line.packageCount, 0)).toBe(3)

      const confirmed = await asAdmin().post(ApiRoutes.pickups.confirm(body.pickup.id)).send()
      expect(confirmed.status).toBe(OK)
      expect((await pickupRow(body.pickup.id)).status).toBe(PickupStatus.CONFIRMED)
    })

    it('adds a guide made later to the pickup of the day, and a manual pickup emptied by hand is cancelled', async () => {
      const first = await guideOn(localId)
      const made = (await request({ connectionId: localId })).body as RequestBody
      const second = await guideOn(localId)

      const again = await request({ connectionId: localId })

      expect(again.status).toBe(CREATED)
      const body = again.body as RequestBody
      expect(body.created).toBe(false)
      expect(body.pickup.id).toBe(made.pickup.id)
      expect(body.joined).toEqual([second.id])
      expect((await pickupRow(made.pickup.id)).packageCount).toBe(2)

      const out = await asAdmin().delete(ApiRoutes.pickups.shipmentById(made.pickup.id, second.id))
      expect(out.status).toBe(OK)
      expect((await shipmentRow(second.id)).pickupId).toBeNull()
      const last = await asAdmin().delete(ApiRoutes.pickups.shipmentById(made.pickup.id, first.id))
      expect(last.status).toBe(OK)
      expect((await pickupRow(made.pickup.id)).status).toBe(PickupStatus.CANCELLED)
    })

    it('has nothing to collect when no guide waits', async () => {
      const none = await request({ connectionId: localId })

      expect(none.status).toBe(CONFLICT)
      expect((none.body as ErrorBody).error.code).toBe(ErrorCodes.PICKUP_NOTHING_TO_COLLECT)
    })
  })

  describe('one open pickup per connection and day', () => {
    it('ends with one pickup when requests race, however many come at once', async () => {
      const guides = await Promise.all([guideOn(localId), guideOn(localId), guideOn(localId)])

      const answers = await Promise.all([
        request({ connectionId: localId }),
        request({ connectionId: localId }),
        request({ connectionId: localId })
      ])

      const created = answers.filter(answer => answer.status === CREATED)
      expect(created.length).toBeGreaterThanOrEqual(1)
      const open = await owner.pickupRequest.findMany({
        where: { connectionId: localId, status: { not: PickupStatus.CANCELLED } }
      })
      expect(open).toHaveLength(1)
      const held = await owner.shipment.findMany({
        where: { id: { in: guides.map(guide => guide.id) } },
        select: { pickupId: true }
      })
      expect(held.every(row => row.pickupId === open[0]?.id)).toBe(true)
      expect(open[0]?.packageCount).toBe(3)
    })

    it('keeps the pickups of a connection apart from the ones of another', async () => {
      await guideOn(localId)
      await guideOn(fullId)

      await request({ connectionId: localId })
      await request({ connectionId: fullId })

      const open = await owner.pickupRequest.findMany({
        where: {
          connectionId: { in: [localId, fullId] },
          status: { not: PickupStatus.CANCELLED }
        }
      })
      expect(open).toHaveLength(2)
    })
  })

  describe('a carrier with a pickup API', () => {
    it('is asked by a job, with the count of the guides, and keeps the reference and what it was told', async () => {
      await guideOn(fullId)
      await guideOn(fullId)

      const made = (await request({ connectionId: fullId })).body as RequestBody

      expect(made.pickup.status).toBe(PickupStatus.PENDING)
      expect(full.callsTo('requestPickup')).toHaveLength(0)
      expect(syncJobs()).toHaveLength(1)
      expect(syncJobs()[0]?.data).toEqual({
        storeId: ctx.storeA.id,
        pickupId: made.pickup.id,
        requestedBy: ctx.adminA.id
      } satisfies SyncPickupJob)
      expect(syncJobs()[0]?.opts).toMatchObject({ attempts: 5, backoff: { type: 'exponential' } })

      expect(await runSync(made.pickup.id)).toBe(PickupSyncOutcomes.DONE)
      expect(full.callsTo('requestPickup')).toHaveLength(1)
      expect(full.callsTo('requestPickup')[0]?.args).toMatchObject({
        packageCount: 2,
        idempotencyKey: `pickup-request:${made.pickup.id}`
      })
      const row = await pickupRow(made.pickup.id)
      expect(row).toMatchObject({ status: PickupStatus.REQUESTED, carrierPackageCount: 2 })
      expect(row.providerPickupId).toMatch(/^FAKE-PICKUP-/)
      // A job that runs twice asks nothing twice
      expect(await runSync(made.pickup.id)).toBe(PickupSyncOutcomes.DONE)
      expect(full.callsTo('requestPickup')).toHaveLength(1)
    })

    it('joins a later guide to the pickup the carrier holds and tells the carrier the new count', async () => {
      await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      await runSync(made.pickup.id)
      const later = await guideOn(fullId)
      queue.jobs.length = 0

      const joined = await request({ connectionId: fullId })

      const body = joined.body as RequestBody
      expect(body).toMatchObject({ created: false, joined: [later.id] })
      expect(body.pickup.revision).toBe(made.pickup.revision + 1)
      expect(syncJobs()).toHaveLength(1)
      expect((await pickupRow(made.pickup.id)).packageCount).toBe(2)
      await runSync(made.pickup.id)
      expect(full.callsTo('modifyPickup')).toHaveLength(1)
      expect(full.callsTo('modifyPickup')[0]?.args).toMatchObject({ packageCount: 2 })
      expect((await pickupRow(made.pickup.id)).carrierPackageCount).toBe(2)
    })

    it('leaves a later guide waiting, with the reason, when the carrier cannot change a pickup', async () => {
      await guideOn(requestOnlyId)
      const made = (await request({ connectionId: requestOnlyId })).body as RequestBody
      await runSync(made.pickup.id)
      const later = await guideOn(requestOnlyId)

      const answer = await request({ connectionId: requestOnlyId })

      const body = answer.body as RequestBody
      expect(body.joined).toEqual([])
      expect(body.waiting).toEqual([
        { shipmentId: later.id, reason: PickupWaitReasons.CARRIER_CANNOT_MODIFY }
      ])
      expect((await shipmentRow(later.id)).pickupId).toBeNull()
      expect((await pickupRow(made.pickup.id)).packageCount).toBe(1)
      expect(requestOnly.callsTo('modifyPickup')).toHaveLength(0)
    })

    it('refuses a change of the pickup of today after its cutoff, and takes it once a person confirmed', async () => {
      await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      await runSync(made.pickup.id)
      const later = await guideOn(fullId)
      // The cutoff of the day is long past
      await owner.carrierConnection.update({
        where: { id: fullId },
        data: { pickupCutoffTime: '00:00' }
      })
      const today = (await pickupRow(made.pickup.id)).pickupDate.toISOString().slice(0, 10)

      const refused = await request({ connectionId: fullId, date: today })
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.PICKUP_CUTOFF_PASSED)
      expect((await shipmentRow(later.id)).pickupId).toBeNull()

      const confirmed = await request({
        connectionId: fullId,
        date: today,
        confirmAfterCutoff: true
      })
      expect(confirmed.status).toBe(CREATED)
      expect((confirmed.body as RequestBody).joined).toEqual([later.id])
    })

    it('asks again while the carrier does not answer, and ends as failed on the last attempt: the guides wait again and the team is told', async () => {
      const first = await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      full.state.pickup = FakeCarrierBehaviors.TIMEOUT_BEFORE

      expect(await runSync(made.pickup.id, false)).toBe(PickupSyncOutcomes.RETRY)
      expect((await pickupRow(made.pickup.id)).status).toBe(PickupStatus.PENDING)

      expect(await runSync(made.pickup.id, true)).toBe(PickupSyncOutcomes.DONE)
      expect(await pickupRow(made.pickup.id)).toMatchObject({
        status: PickupStatus.FAILED,
        lastError: PickupFailureNotes.UNAVAILABLE
      })
      expect((await shipmentRow(first.id)).pickupId).toBeNull()
      const told = await until(
        () => notices(made.pickup.id),
        rows => rows.length > 0
      )
      expect(told.length).toBeGreaterThan(0)

      // The agent asks again: a new pickup, with the same guide
      full.state.pickup = FakeCarrierBehaviors.OK
      const again = (await request({ connectionId: fullId })).body as RequestBody
      expect(again.pickup.id).not.toBe(made.pickup.id)
      expect(again.joined).toEqual([first.id])
    })

    it('ends a refused request at once, with the words of the carrier bounded', async () => {
      await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      full.state.pickup = FakeCarrierBehaviors.REJECT

      expect(await runSync(made.pickup.id, false)).toBe(PickupSyncOutcomes.DONE)

      const row = await pickupRow(made.pickup.id)
      expect(row.status).toBe(PickupStatus.FAILED)
      expect(row.lastError).toBe('The fake carrier refuses pickups')
    })

    it('tells the carrier a count again when it was left behind (the resync), and the last attempt leaves a note', async () => {
      await guideOn(fullId)
      await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      await runSync(made.pickup.id)
      // Two voids landed out of order: the carrier holds 1, the guides hold 2
      await owner.pickupRequest.update({
        where: { id: made.pickup.id },
        data: { carrierPackageCount: 1 }
      })
      full.state.calls.length = 0

      expect(await runSync(made.pickup.id)).toBe(PickupSyncOutcomes.DONE)

      expect(full.callsTo('modifyPickup')[0]?.args).toMatchObject({ packageCount: 2 })
      expect((await pickupRow(made.pickup.id)).carrierPackageCount).toBe(2)

      await owner.pickupRequest.update({
        where: { id: made.pickup.id },
        data: { carrierPackageCount: 1 }
      })
      full.state.pickup = FakeCarrierBehaviors.TIMEOUT_BEFORE
      expect(await runSync(made.pickup.id, false)).toBe(PickupSyncOutcomes.RETRY)
      expect(await runSync(made.pickup.id, true)).toBe(PickupSyncOutcomes.DONE)
      expect((await pickupRow(made.pickup.id)).lastError).toBe('shipment_left_carrier_not_updated')
    })

    it('lowers the count of the pickup, and tells the carrier, when a guide of it is cancelled', async () => {
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: 'CONFIRMED',
        shippingAddress: { line1: 'Calle 1', city: 'San Salvador', state: 'SS', country: 'SV' }
      })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: order.productId,
        warehouseId: ctx.warehouseA.id,
        onHand: 5,
        reserved: 1
      })
      const kept = await guideOn(fullId)
      const dropped = await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      await runSync(made.pickup.id)
      full.state.calls.length = 0

      // The carrier knows the guide, so the void can end
      full.state.guides.set(dropped.guideNumber, {
        guideNumber: dropped.guideNumber,
        providerShipmentId: 'P-1',
        reference: 'R-1',
        idempotencyKey: 'K-1',
        voided: false,
        pickupRef: null,
        rawStatus: 'created'
      })

      const cancelled = await asAdmin().post(ApiRoutes.shipments.cancel(dropped.id)).send()

      expect(cancelled.status).toBe(OK)
      // The guide leaves the pickup when the void ends (the job that asks the carrier)
      await cancellation.settle(ctx.storeA.id, dropped.id, carrierId => registry.find(carrierId), {
        actor: { type: 'user', id: ctx.adminA.id },
        lastAttempt: false
      })
      const row = await pickupRow(made.pickup.id)
      expect(row.packageCount).toBe(1)
      expect(row.carrierPackageCount).toBe(1)
      expect(full.callsTo('modifyPickup')[0]?.args).toMatchObject({ packageCount: 1 })
      expect((await shipmentRow(kept.id)).pickupId).toBe(made.pickup.id)
      expect((await shipmentRow(dropped.id)).pickupId).toBeNull()
    })

    it('cancels at the carrier first, gives the guides back, and does not cancel a pickup still being asked for', async () => {
      const guide = await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody

      const early = await asAdmin().post(ApiRoutes.pickups.cancel(made.pickup.id)).send()
      expect(early.status).toBe(CONFLICT)
      expect((early.body as ErrorBody).error.code).toBe(ErrorCodes.PICKUP_NOT_EDITABLE)

      await runSync(made.pickup.id)
      const cancelled = await asAdmin().post(ApiRoutes.pickups.cancel(made.pickup.id)).send()

      expect(cancelled.status).toBe(OK)
      expect(full.callsTo('cancelPickup')).toHaveLength(1)
      expect((await pickupRow(made.pickup.id)).status).toBe(PickupStatus.CANCELLED)
      expect((await shipmentRow(guide.id)).pickupId).toBeNull()
    })

    it('does not ask the carrier for a pickup that lost every guide, and asks a refused count once', async () => {
      const lone = await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      // Its only guide was voided before the job ran
      await owner.shipment.update({ where: { id: lone.id }, data: { pickupId: null } })
      await owner.pickupRequest.update({ where: { id: made.pickup.id }, data: { packageCount: 0 } })

      expect(await runSync(made.pickup.id)).toBe(PickupSyncOutcomes.DONE)

      expect(full.callsTo('requestPickup')).toHaveLength(0)
      expect((await pickupRow(made.pickup.id)).status).toBe(PickupStatus.FAILED)

      await guideOn(fullId)
      const second = (await request({ connectionId: fullId })).body as RequestBody
      await runSync(second.pickup.id)
      await guideOn(fullId)
      await request({ connectionId: fullId })
      // The lone guide of the first pickup waits again, so the carrier holds 2 and the guides hold 3: the count has to be told
      expect(await pickupRow(second.pickup.id)).toMatchObject({
        packageCount: 3,
        carrierPackageCount: 2
      })
      full.state.pickup = FakeCarrierBehaviors.REJECT
      full.state.calls.length = 0

      await runSync(second.pickup.id)

      // A refusal does not change by asking again inside the same job: one call, a note for the agent, the count still behind
      expect(full.callsTo('modifyPickup')).toHaveLength(1)
      expect(await pickupRow(second.pickup.id)).toMatchObject({
        lastError: 'shipment_left_carrier_not_updated',
        carrierPackageCount: 2
      })
    })

    it('answers 503 and keeps the pickup when the carrier does not cancel it', async () => {
      await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      await runSync(made.pickup.id)
      full.state.pickup = FakeCarrierBehaviors.TIMEOUT_BEFORE

      const cancelled = await asAdmin().post(ApiRoutes.pickups.cancel(made.pickup.id)).send()

      expect(cancelled.status).toBe(503)
      expect((await pickupRow(made.pickup.id)).status).toBe(PickupStatus.REQUESTED)
    })

    it('does not take the last guide out of a pickup the carrier holds', async () => {
      const guide = await guideOn(fullId)
      const made = (await request({ connectionId: fullId })).body as RequestBody
      await runSync(made.pickup.id)

      const out = await asAdmin().delete(ApiRoutes.pickups.shipmentById(made.pickup.id, guide.id))

      expect(out.status).toBe(CONFLICT)
      expect((await shipmentRow(guide.id)).pickupId).toBe(made.pickup.id)
    })
  })

  describe('what the connection and the guides allow', () => {
    it('refuses a connection that takes no pickups, and a guide that is not waiting for one', async () => {
      await owner.carrierConnection.update({
        where: { id: localId },
        data: { pickupEnabled: false }
      })
      await guideOn(localId)
      const off = await request({ connectionId: localId })
      expect(off.status).toBe(CONFLICT)
      expect((off.body as ErrorBody).error.code).toBe(ErrorCodes.PICKUP_NOT_ENABLED)

      await owner.carrierConnection.update({
        where: { id: localId },
        data: { pickupEnabled: true }
      })
      const gone = await createGuideOn(owner, {
        storeId: ctx.storeA.id,
        connectionId: localId,
        serviceCode: services.get(localId) ?? 'local',
        status: ShipmentStatus.IN_TRANSIT
      })
      const refused = await request({ connectionId: localId, shipmentIds: [gone.id] })
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.PICKUP_SHIPMENT_NOT_ELIGIBLE)
    })

    it('does not join guides to a pickup that is over, and makes no other pickup behind the back of the agent', async () => {
      const first = await guideOn(localId)
      const made = (await request({ connectionId: localId })).body as RequestBody
      await asAdmin().post(ApiRoutes.pickups.cancel(made.pickup.id)).send()
      const later = await guideOn(localId)

      const add = await asAdmin()
        .post(ApiRoutes.pickups.shipments(made.pickup.id))
        .send({ shipmentIds: [later.id] })

      expect(add.status).toBe(CONFLICT)
      expect((add.body as ErrorBody).error.code).toBe(ErrorCodes.PICKUP_NOT_EDITABLE)
      expect((await shipmentRow(later.id)).pickupId).toBeNull()
      expect((await shipmentRow(first.id)).pickupId).toBeNull()
      const open = await owner.pickupRequest.count({
        where: { connectionId: localId, status: { not: PickupStatus.CANCELLED } }
      })
      expect(open).toBe(0)
    })

    it('does not make a pickup of today after its cutoff without the confirmation of a person', async () => {
      await guideOn(localId)
      await owner.carrierConnection.update({
        where: { id: localId },
        data: { pickupCutoffTime: '00:00' }
      })
      // Today as the store reads it
      const { timezone } = await owner.store.findUniqueOrThrow({
        where: { id: ctx.storeA.id },
        select: { timezone: true }
      })
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())

      const refused = await request({ connectionId: localId, date: today })

      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.PICKUP_CUTOFF_PASSED)
      const confirmed = await request({
        connectionId: localId,
        date: today,
        confirmAfterCutoff: true
      })
      expect(confirmed.status).toBe(CREATED)
    })

    it('refuses a day that is over and a day the carrier does not come', async () => {
      await guideOn(localId)
      await owner.carrierConnection.update({ where: { id: localId }, data: { pickupDays: [1] } })

      const past = await request({ connectionId: localId, date: '2020-01-06' })
      expect(past.status).toBe(400)
      // 2031-01-07 is a Tuesday
      const tuesday = await request({ connectionId: localId, date: '2031-01-07' })
      expect(tuesday.status).toBe(400)
      const monday = await request({ connectionId: localId, date: '2031-01-06' })
      expect(monday.status).toBe(CREATED)
    })

    it('lets a member who only reads see pickups and the manifest, and not ask for one', async () => {
      await guideOn(localId)
      const made = (await request({ connectionId: localId })).body as RequestBody
      const asViewer = () => api(app, ctx.viewerA, ctx.storeA)

      const list = await asViewer().get(ApiRoutes.pickups.list)
      expect(list.status).toBe(OK)
      expect((await asViewer().get(ApiRoutes.pickups.manifest(made.pickup.id))).status).toBe(OK)
      expect(
        (await asViewer().post(ApiRoutes.pickups.create).send({ connectionId: localId })).status
      ).toBe(FORBIDDEN)
      expect((await asViewer().post(ApiRoutes.pickups.confirm(made.pickup.id)).send()).status).toBe(
        FORBIDDEN
      )
    })

    it('does not show a pickup of this store to another store', async () => {
      await guideOn(localId)
      const made = (await request({ connectionId: localId })).body as RequestBody
      const asOther = () => api(app, ctx.adminB, ctx.storeB)

      expect((await asOther().get(ApiRoutes.pickups.manifest(made.pickup.id))).status).toBe(
        NOT_FOUND
      )
      expect((await asOther().post(ApiRoutes.pickups.confirm(made.pickup.id)).send()).status).toBe(
        NOT_FOUND
      )
      const theirs = await asOther().get(ApiRoutes.pickups.list)
      expect(
        (theirs.body as { data: { id: string }[] }).data.some(row => row.id === made.pickup.id)
      ).toBe(false)
      expect(
        (await asOther().post(ApiRoutes.pickups.create).send({ connectionId: localId })).status
      ).toBe(NOT_FOUND)
    })
  })
})
