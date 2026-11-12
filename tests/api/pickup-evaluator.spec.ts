import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import type { Redis } from 'ioredis'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { CacheKeys } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { CarrierId, OrderStatus, PickupStatus, ShipmentStatus } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { NotificationTypes } from '@platform/core/notifications'
import {
  evaluatePickupsJobId,
  syncPickupJobId,
  JobNames,
  QueueNames,
  syncPickupSweepJobId
} from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import { PickupsService, PickupSync, ShippingService, storeClockOf } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { PickupEvaluateScheduler } from '../../apps/worker/src/schedulers/pickup-evaluate.scheduler'
import { PickupEvaluator } from '../../apps/worker/src/shipping/pickup-evaluator.service'
import {
  buildFakeCarrier,
  createCarrierConnection,
  createGuideOn,
  createInventoryLevel,
  createOrder,
  type FakeCarrier
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import type { CapturedQueue } from '../helpers/queue'

const ATTEMPTS = 80
const POLL_MS = 100
const MINUTE_MS = 60_000

const quietLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as PinoLogger

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let attempt = 0; attempt < ATTEMPTS && !done(value); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    value = await read()
  }
  return value
}

// 'HH:mm' plus minutes, inside the day
const plus = (time: string, minutes: number): string => {
  const [h, m] = time.split(':').map(Number)
  const total = Math.min(23 * 60 + 59, (h ?? 0) * 60 + (m ?? 0) + minutes)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

describe('The pickup scheduler (TDD_17 §4.10)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let registry: CarrierRegistry
  let evaluator: PickupEvaluator
  let redis: Redis
  let sync: PickupSync
  let queue: CapturedQueue
  let full: FakeCarrier
  let bound: FakeCarrier
  let localId = ''
  let fullId = ''
  let boundId = ''
  const services = new Map<string, string>()
  // A Monday at midday UTC, far from today: the store reads it as some time of its own day
  const NOW = new Date('2031-01-06T12:00:00.000Z')
  let clock = { weekday: 1, date: '2031-01-06', time: '12:00' }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(CarrierRegistry, { strict: false })
    queue = app.get<CapturedQueue>(getQueueToken(QueueNames.HEAVY_PROCESSING), { strict: false })
    sync = app.get(PickupSync, { strict: false })
    redis = app.get<Redis>(REDIS_CLIENT, { strict: false })
    evaluator = new PickupEvaluator(
      app.get(PrismaService, { strict: false }),
      registry,
      app.get(PickupsService, { strict: false }),
      app.get(ShippingService, { strict: false }),
      app.get(DomainEvents, { strict: false }),
      redis,
      queue as never,
      quietLogger
    )
    full = buildFakeCarrier({
      id: CarrierId.FORZA,
      cancel: true,
      pickupRequest: true,
      pickupModify: true,
      pickupCancel: true
    })
    bound = buildFakeCarrier({ id: CarrierId.C807, mode: 'pickup_bound', pickupModify: true })
    registry.register(full.plugin)
    registry.register(bound.plugin)
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    const { timezone } = await owner.store.findUniqueOrThrow({
      where: { id: ctx.storeA.id },
      select: { timezone: true }
    })
    clock = storeClockOf(NOW, timezone)
    const make = async (carrierId?: (typeof CarrierId)[keyof typeof CarrierId]) => {
      const built = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        ...(carrierId === undefined ? { prefix: 'EV' } : { carrierId })
      })
      services.set(built.id, built.serviceCode)
      return built.id
    }
    localId = await make()
    fullId = await make(CarrierId.FORZA)
    boundId = await make(CarrierId.C807)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    for (const fake of [full, bound]) {
      fake.state.guides.clear()
      fake.state.pickups.clear()
      fake.state.calls.length = 0
    }
    queue.jobs.length = 0
    // What the scheduler remembers of the day is not carried from one case to the next
    await redis.del(
      ...[localId, fullId, boundId].flatMap(id => [
        CacheKeys.pickup.cutoffReminder(id, clock.date),
        CacheKeys.pickup.autoRun(id, clock.date)
      ])
    )
    // The pickup day of the clock, an auto request from the start of the day and a cutoff twenty minutes from "now"
    await owner.carrierConnection.updateMany({
      where: { id: { in: [localId, fullId, boundId] } },
      data: {
        pickupEnabled: true,
        pickupDays: [clock.weekday],
        pickupCutoffTime: plus(clock.time, 20),
        autoPickup: true,
        autoPickupTime: '00:00',
        pickupReminderMinutes: 30
      }
    })
    await owner.shipment.updateMany({
      where: { connectionId: { in: [localId, fullId, boundId] } },
      data: { pickupId: null, status: ShipmentStatus.CANCELLED }
    })
    await owner.pickupRequest.updateMany({
      where: { connectionId: { in: [localId, fullId, boundId] } },
      data: { status: PickupStatus.CANCELLED }
    })
  })

  const guideOn = (connectionId: string) =>
    createGuideOn(owner, {
      storeId: ctx.storeA.id,
      connectionId,
      serviceCode: services.get(connectionId) ?? 'local'
    })
  const open = (connectionId: string) =>
    owner.pickupRequest.findMany({
      where: { connectionId, status: { not: PickupStatus.CANCELLED } }
    })
  const syncJobsOf = (pickupId: string) =>
    queue.jobs.filter(
      job =>
        job.name === JobNames.SYNC_PICKUP &&
        (job.data as { pickupId: string }).pickupId === pickupId
    )
  // The job of the request side (the sweep has ids of its own)
  const requestJobsOf = (pickupId: string, revision: number) =>
    syncJobsOf(pickupId).filter(job => job.opts?.jobId === syncPickupJobId(pickupId, revision))
  const reminders = (connectionId: string) =>
    owner.notification.findMany({
      where: { resourceId: connectionId, type: NotificationTypes.PICKUP_CUTOFF_APPROACHING }
    })

  describe('at the auto-request time', () => {
    it('makes one pickup of the waiting guides, once however many minutes look', async () => {
      await guideOn(localId)
      await guideOn(localId)

      const first = await evaluator.evaluate(NOW)
      await evaluator.evaluate(new Date(NOW.getTime() + MINUTE_MS))
      await evaluator.evaluate(new Date(NOW.getTime() + 2 * MINUTE_MS))

      expect(first.pickupsMade).toBeGreaterThanOrEqual(1)
      const pickups = await open(localId)
      expect(pickups).toHaveLength(1)
      expect(pickups[0]).toMatchObject({ status: PickupStatus.MANUAL_REQUIRED, packageCount: 2 })
    })

    it('ends with one pickup when a request of a person races the scheduler', async () => {
      await guideOn(localId)
      await guideOn(localId)

      await Promise.all([
        evaluator.evaluate(NOW),
        api(app, ctx.adminA, ctx.storeA)
          .post(ApiRoutes.pickups.create)
          .send({ connectionId: localId, date: clock.date })
      ])

      expect(await open(localId)).toHaveLength(1)
      const held = await owner.shipment.count({
        where: {
          connectionId: localId,
          pickupId: { not: null },
          status: ShipmentStatus.LABEL_CREATED
        }
      })
      expect(held).toBe(2)
    })

    it('asks the carrier by a job, and a later guide joins the pickup the carrier can change', async () => {
      await guideOn(fullId)
      await evaluator.evaluate(NOW)
      const [pickup] = await open(fullId)
      expect(pickup?.status).toBe(PickupStatus.PENDING)
      expect(requestJobsOf(pickup?.id ?? '', 1)).toHaveLength(1)
      await sync.run(ctx.storeA.id, pickup?.id ?? '', id => registry.find(id), false)
      const later = await guideOn(fullId)
      queue.jobs.length = 0

      await evaluator.evaluate(new Date(NOW.getTime() + MINUTE_MS))

      expect((await owner.shipment.findUniqueOrThrow({ where: { id: later.id } })).pickupId).toBe(
        pickup?.id
      )
      expect(requestJobsOf(pickup?.id ?? '', 2)).toHaveLength(1)
      expect(await open(fullId)).toHaveLength(1)
    })

    it('does nothing before its time, with auto requests off, on a day the carrier does not come, or with nothing waiting', async () => {
      await guideOn(localId)
      await owner.carrierConnection.update({
        where: { id: localId },
        data: { autoPickupTime: plus(clock.time, 5) }
      })
      await evaluator.evaluate(NOW)
      expect(await open(localId)).toHaveLength(0)

      await owner.carrierConnection.update({
        where: { id: localId },
        data: { autoPickupTime: '00:00', autoPickup: false }
      })
      await evaluator.evaluate(NOW)
      expect(await open(localId)).toHaveLength(0)

      await owner.carrierConnection.update({
        where: { id: localId },
        data: { autoPickup: true, pickupDays: [clock.weekday === 7 ? 1 : clock.weekday + 1] }
      })
      await evaluator.evaluate(NOW)
      expect(await open(localId)).toHaveLength(0)

      await owner.shipment.updateMany({
        where: { connectionId: localId },
        data: { status: ShipmentStatus.CANCELLED }
      })
      await owner.carrierConnection.update({
        where: { id: localId },
        data: { pickupDays: [clock.weekday] }
      })
      await evaluator.evaluate(NOW)
      expect(await open(localId)).toHaveLength(0)
    })
  })

  describe('the cutoff reminder', () => {
    it('is raised once a day for a connection whose guides still wait, to the members who manage pickups', async () => {
      await owner.carrierConnection.update({
        where: { id: localId },
        data: { autoPickup: false }
      })
      await guideOn(localId)

      const first = await evaluator.evaluate(NOW)
      const second = await evaluator.evaluate(new Date(NOW.getTime() + MINUTE_MS))
      const third = await evaluator.evaluate(new Date(NOW.getTime() + 2 * MINUTE_MS))

      // Raised once for the day, not once per minute of the window
      expect(first.reminders).toBe(1)
      expect(second.reminders + third.reminders).toBe(0)
      const told = await until(
        () => reminders(localId),
        rows => rows.length > 0
      )
      // The members who manage pickups, once each: an administrator hears it and a viewer does not
      const heard = told.map(row => row.userId)
      expect(heard).toContain(ctx.adminA.id)
      expect(heard).not.toContain(ctx.viewerA.id)
      expect(new Set(heard).size).toBe(heard.length)
    })

    it('is still raised when the automatic pickup of the same minute fails', async () => {
      await guideOn(localId)
      const pickups = app.get(PickupsService, { strict: false })
      const spy = jest.spyOn(pickups, 'ensurePickup').mockRejectedValueOnce(new Error('lock lost'))

      const report = await evaluator.evaluate(NOW)
      spy.mockRestore()

      expect(report.failed).toBeGreaterThanOrEqual(1)
      expect(report.reminders).toBeGreaterThanOrEqual(1)
    })

    it('is tried again the next minute when it could not be raised', async () => {
      await owner.carrierConnection.update({ where: { id: localId }, data: { autoPickup: false } })
      await guideOn(localId)
      const events = app.get(DomainEvents, { strict: false })
      const spy = jest.spyOn(events, 'publish').mockImplementationOnce(() => {
        throw new Error('database blip')
      })

      const first = await evaluator.evaluate(NOW)
      spy.mockRestore()
      const second = await evaluator.evaluate(new Date(NOW.getTime() + MINUTE_MS))

      expect(first.reminders).toBe(0)
      expect(second.reminders).toBe(1)
    })

    it('is not raised outside its window, or when nothing waits', async () => {
      await owner.carrierConnection.update({
        where: { id: localId },
        data: { autoPickup: false, pickupCutoffTime: plus(clock.time, 120) }
      })
      await guideOn(localId)
      expect((await evaluator.evaluate(NOW)).reminders).toBe(0)

      await owner.carrierConnection.update({
        where: { id: localId },
        data: { pickupCutoffTime: plus(clock.time, 10) }
      })
      await owner.shipment.updateMany({
        where: { connectionId: localId },
        data: { status: ShipmentStatus.CANCELLED }
      })
      expect((await evaluator.evaluate(NOW)).reminders).toBe(0)
    })
  })

  describe('a carrier that makes its pickup with its guides', () => {
    it('makes the guides of the orders planned for it, once a day', async () => {
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.CONFIRMED,
        carrierConnectionId: boundId,
        shippingAddress: { line1: 'Calle 1', city: 'San Salvador', state: 'SS', country: 'SV' },
        allocatedAt: ctx.warehouseA.id
      })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: order.productId,
        warehouseId: ctx.warehouseA.id,
        onHand: 5,
        reserved: 1
      })

      const first = await evaluator.evaluate(NOW)
      const second = await evaluator.evaluate(new Date(NOW.getTime() + MINUTE_MS))

      expect(first.guidesMade).toBeGreaterThanOrEqual(1)
      expect(second.guidesMade).toBe(0)
      const made = await owner.shipment.findMany({
        where: { orderId: order.id, status: { not: ShipmentStatus.CANCELLED } }
      })
      expect(made).toHaveLength(1)
      expect(made[0]?.pickupId).not.toBeNull()
      expect(bound.callsTo('createShipmentsWithPickup')).toHaveLength(1)
    })

    it('is tried again when a run fails before it ends, and does not repeat a run that ended', async () => {
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.CONFIRMED,
        carrierConnectionId: boundId,
        shippingAddress: { line1: 'Calle 1', city: 'San Salvador', state: 'SS', country: 'SV' },
        allocatedAt: ctx.warehouseA.id
      })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: order.productId,
        warehouseId: ctx.warehouseA.id,
        onHand: 5,
        reserved: 1
      })
      const engine = app.get(ShippingService, { strict: false })
      const spy = jest.spyOn(engine, 'createShipments').mockRejectedValueOnce(new Error('down'))

      const first = await evaluator.evaluate(NOW)
      spy.mockRestore()
      const second = await evaluator.evaluate(new Date(NOW.getTime() + MINUTE_MS))

      expect(first.failed).toBeGreaterThanOrEqual(1)
      // (an order of an earlier case, whose guide was voided, is planned for the connection too)
      expect(second.guidesMade).toBeGreaterThanOrEqual(1)
      expect(await owner.shipment.count({ where: { orderId: order.id } })).toBe(1)
    })

    it('does not make guides when auto requests are off', async () => {
      await owner.carrierConnection.update({ where: { id: boundId }, data: { autoPickup: false } })
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        status: OrderStatus.CONFIRMED,
        carrierConnectionId: boundId,
        shippingAddress: { line1: 'Calle 1', city: 'San Salvador', state: 'SS', country: 'SV' },
        allocatedAt: ctx.warehouseA.id
      })

      await evaluator.evaluate(NOW)

      expect(await owner.shipment.count({ where: { orderId: order.id } })).toBe(0)
    })
  })

  describe('the sweep', () => {
    it('asks again for a pickup nobody queued and for a count the carrier has not acknowledged', async () => {
      const old = new Date(NOW.getTime() - 60 * MINUTE_MS)
      const stuck = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: fullId,
          pickupDate: new Date('2031-01-06T00:00:00.000Z'),
          status: PickupStatus.PENDING,
          packageCount: 1,
          requestedBy: 'system',
          createdAt: old
        }
      })
      const behind = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: fullId,
          pickupDate: new Date('2031-01-07T00:00:00.000Z'),
          status: PickupStatus.REQUESTED,
          packageCount: 3,
          carrierPackageCount: 2,
          providerPickupId: 'FAKE-PICKUP-X',
          requestedBy: 'system'
        }
      })
      await owner.pickupRequest.updateMany({ where: { id: behind.id }, data: { updatedAt: old } })
      const agreed = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: fullId,
          pickupDate: new Date('2031-01-08T00:00:00.000Z'),
          status: PickupStatus.REQUESTED,
          packageCount: 2,
          carrierPackageCount: 2,
          providerPickupId: 'FAKE-PICKUP-Y',
          requestedBy: 'system'
        }
      })
      await owner.pickupRequest.updateMany({ where: { id: agreed.id }, data: { updatedAt: old } })

      await evaluator.evaluate(NOW)

      const bucket = Math.floor(NOW.getTime() / (30 * MINUTE_MS))
      expect(syncJobsOf(stuck.id).map(job => job.opts?.jobId)).toEqual([
        syncPickupSweepJobId(stuck.id, bucket)
      ])
      expect(syncJobsOf(behind.id).map(job => job.opts?.jobId)).toEqual([
        syncPickupSweepJobId(behind.id, bucket)
      ])
      expect(syncJobsOf(agreed.id)).toHaveLength(0)
      expect(syncJobsOf(stuck.id)[0]?.data).toEqual({
        storeId: ctx.storeA.id,
        pickupId: stuck.id,
        requestedBy: null
      })
    })

    it('finds the pickups that are behind however many that agree are older', async () => {
      const old = new Date(NOW.getTime() - 120 * MINUTE_MS)
      const older = new Date(NOW.getTime() - 240 * MINUTE_MS)
      await owner.pickupRequest.createMany({
        data: Array.from({ length: 105 }, (_unused, index) => ({
          storeId: ctx.storeA.id,
          connectionId: fullId,
          pickupDate: new Date(Date.UTC(2032, 0, 1 + (index % 28))),
          status: PickupStatus.REQUESTED,
          packageCount: 2,
          carrierPackageCount: 2,
          providerPickupId: `FAKE-AGREED-${index}`,
          requestedBy: 'system',
          updatedAt: older
        }))
      })
      const behind = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: fullId,
          pickupDate: new Date('2031-01-10T00:00:00.000Z'),
          status: PickupStatus.REQUESTED,
          packageCount: 4,
          carrierPackageCount: 3,
          providerPickupId: 'FAKE-BEHIND',
          requestedBy: 'system'
        }
      })
      await owner.pickupRequest.updateMany({ where: { id: behind.id }, data: { updatedAt: old } })

      await evaluator.evaluate(NOW)

      expect(syncJobsOf(behind.id)).toHaveLength(1)
    })

    it('leaves a recent pickup alone', async () => {
      const fresh = await owner.pickupRequest.create({
        data: {
          storeId: ctx.storeA.id,
          connectionId: fullId,
          pickupDate: new Date('2031-01-09T00:00:00.000Z'),
          status: PickupStatus.PENDING,
          packageCount: 1,
          requestedBy: 'system',
          createdAt: NOW
        }
      })

      await evaluator.evaluate(NOW)

      expect(syncJobsOf(fresh.id)).toHaveLength(0)
    })
  })

  describe('the minute job', () => {
    it('is one job per minute whoever asks, and one evaluation per minute whatever the queue keeps', async () => {
      const scheduler = new PickupEvaluateScheduler({} as never, queue as never, quietLogger)

      await scheduler.enqueue(NOW)
      const minute = Math.floor(NOW.getTime() / MINUTE_MS)
      const jobs = queue.jobs.filter(job => job.name === JobNames.EVALUATE_PICKUPS)
      expect(jobs.map(job => job.opts?.jobId)).toEqual([evaluatePickupsJobId(minute)])
      expect(jobs[0]?.data).toEqual({ minute })

      // A minute of its own for each run of this case: the claim of a minute lives for three
      const mine = minute + (Date.now() % 1_000_000)
      const atMinute = mine * MINUTE_MS
      expect(await evaluator.run({ minute: mine }, atMinute + 11 * MINUTE_MS)).toBeNull()
      expect(await evaluator.run({ minute: mine }, atMinute + MINUTE_MS)).not.toBeNull()
      // The same minute asked again (a second replica, a retention that forgot the first job) evaluates nothing
      expect(await evaluator.run({ minute: mine }, atMinute + MINUTE_MS)).toBeNull()
    })
  })
})
