import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierConnectionStatus,
  CarrierEventOutcomes,
  CarrierId,
  ShipmentEventSource,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { JobNames, pollShipmentStatusJobId, QueueNames } from '@platform/core/queues'
import { ShipmentStatusEngine, ShipmentWrites } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { ShipmentPollScheduler } from '../../apps/worker/src/schedulers/shipment-poll.scheduler'
import { ShipmentPoller } from '../../apps/worker/src/shipping/shipment-poller.service'
import {
  buildFakeCarrier,
  createCarrierConnection,
  createOrder,
  createShipment,
  type FakeCarrier
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue } from '../helpers/queue'

const DAY_MS = 24 * 60 * 60 * 1000
const { APPLIED, DUPLICATE, STORED, IGNORED } = CarrierEventOutcomes
const quietLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as PinoLogger

describe('The status flow from the carrier: engine, poll and schedule (TDD_17 §4.9)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let engine: ShipmentStatusEngine
  let poller: ShipmentPoller
  let forza: FakeCarrier
  let prisma: PrismaService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(CarrierRegistry, { strict: false })
    forza = buildFakeCarrier({ id: CarrierId.FORZA, fetchStatus: true, webhook: false })
    registry.register(forza.plugin)
    engine = new ShipmentStatusEngine(prisma, app.get(ShipmentWrites, { strict: false }))
    poller = new ShipmentPoller(
      prisma,
      registry,
      app.get(CredentialCipher, { strict: false }),
      engine,
      quietLogger
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const statusOf = async (id: string) =>
    (await owner.shipment.findUniqueOrThrow({ where: { id } })).status
  const attemptsOf = async (id: string) =>
    (await owner.shipment.findUniqueOrThrow({ where: { id } })).failedAttempts
  const historyOf = (id: string) =>
    owner.shipmentEvent.findMany({ where: { shipmentId: id }, orderBy: { occurredAt: 'asc' } })
  const apply = (
    shipmentId: string,
    status: ShipmentStatus,
    extra: { id?: string; at?: Date; storeId?: string } = {}
  ) =>
    engine.apply(
      extra.storeId ?? ctx.storeA.id,
      shipmentId,
      {
        status,
        rawStatus: status,
        occurredAt: extra.at ?? new Date(),
        ...(extra.id === undefined ? {} : { providerEventId: extra.id })
      },
      ShipmentEventSource.WEBHOOK
    )

  describe('the engine', () => {
    it('counts three failed attempts on three days, then a delivery, and a re-sent event counts once', async () => {
      const { id } = await createShipment(owner, { storeId: ctx.storeA.id })
      const start = Date.now() - 6 * DAY_MS
      await owner.shipment.update({ where: { id }, data: { createdAt: new Date(start) } })
      const day = (n: number) => new Date(start + n * DAY_MS)
      expect(await apply(id, ShipmentStatus.PICKED_UP, { id: 'e1', at: day(1) })).toBe(APPLIED)
      expect(await apply(id, ShipmentStatus.OUT_FOR_DELIVERY, { id: 'e2', at: day(2) })).toBe(
        APPLIED
      )
      expect(await apply(id, ShipmentStatus.FAILED_ATTEMPT, { id: 'e3', at: day(2.5) })).toBe(
        APPLIED
      )
      // The carrier sends the second failure again (a retry of its webhook): the same event is not another attempt
      expect(await apply(id, ShipmentStatus.FAILED_ATTEMPT, { id: 'e4', at: day(3.5) })).toBe(
        APPLIED
      )
      expect(await apply(id, ShipmentStatus.FAILED_ATTEMPT, { id: 'e4', at: day(3.5) })).toBe(
        DUPLICATE
      )
      expect(await apply(id, ShipmentStatus.FAILED_ATTEMPT, { id: 'e5', at: day(4.5) })).toBe(
        APPLIED
      )
      expect(await attemptsOf(id)).toBe(3)
      expect(await apply(id, ShipmentStatus.DELIVERED, { id: 'e6', at: day(5) })).toBe(APPLIED)
      expect(await statusOf(id)).toBe(ShipmentStatus.DELIVERED)
      expect(await attemptsOf(id)).toBe(3)
      const history = await historyOf(id)
      expect(history.filter(row => row.status === ShipmentStatus.FAILED_ATTEMPT)).toHaveLength(3)
    })

    it('dedupes on status and moment when the carrier sends no event id', async () => {
      const { id } = await createShipment(owner, { storeId: ctx.storeA.id })
      const at = new Date()
      expect(await apply(id, ShipmentStatus.PICKED_UP, { at })).toBe(APPLIED)
      expect(await apply(id, ShipmentStatus.PICKED_UP, { at })).toBe(DUPLICATE)
      expect(await historyOf(id)).toHaveLength(2)
    })

    it('stores an event that comes late and changes nothing', async () => {
      const { id } = await createShipment(owner, { storeId: ctx.storeA.id })
      expect(await apply(id, ShipmentStatus.IN_TRANSIT, { id: 'a' })).toBe(APPLIED)
      expect(
        await apply(id, ShipmentStatus.PICKED_UP, { id: 'b', at: new Date(Date.now() - 1000) })
      ).toBe(STORED)
      expect(await statusOf(id)).toBe(ShipmentStatus.IN_TRANSIT)
      expect((await historyOf(id)).map(row => row.status)).toContain(ShipmentStatus.PICKED_UP)
      // And a delivered package is not moved by anything that follows
      expect(await apply(id, ShipmentStatus.DELIVERED, { id: 'c' })).toBe(APPLIED)
      expect(await apply(id, ShipmentStatus.OUT_FOR_DELIVERY, { id: 'd' })).toBe(STORED)
      expect(await statusOf(id)).toBe(ShipmentStatus.DELIVERED)
    })

    it('keeps in the history a status that a carrier does not set, and never moves with it', async () => {
      const { id } = await createShipment(owner, { storeId: ctx.storeA.id })
      expect(await apply(id, ShipmentStatus.CANCELLED, { id: 'x' })).toBe(STORED)
      expect(await apply(id, ShipmentStatus.REQUIRES_REVIEW, { id: 'y' })).toBe(STORED)
      expect(await statusOf(id)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('applies an event delivered twice at the same moment once', async () => {
      const { id } = await createShipment(owner, { storeId: ctx.storeA.id })
      const results = await Promise.all([
        apply(id, ShipmentStatus.PICKED_UP, { id: 'same' }),
        apply(id, ShipmentStatus.PICKED_UP, { id: 'same' })
      ])
      expect(results.sort()).toEqual([APPLIED, DUPLICATE].sort())
      expect(await historyOf(id)).toHaveLength(2)
    })

    it('drops the events of a disconnected connection, and of a shipment of another store', async () => {
      const { id, connectionId } = await createShipment(owner, { storeId: ctx.storeA.id })
      expect(await apply(id, ShipmentStatus.PICKED_UP, { id: 'z', storeId: ctx.storeB.id })).toBe(
        IGNORED
      )
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { status: CarrierConnectionStatus.DISABLED }
      })
      expect(await apply(id, ShipmentStatus.PICKED_UP, { id: 'w' })).toBe(IGNORED)
      expect(await statusOf(id)).toBe(ShipmentStatus.LABEL_CREATED)
      expect(await historyOf(id)).toHaveLength(1)
    })

    it('ignores an event whose moment is not a moment, or that comes before the guide existed', async () => {
      const { id } = await createShipment(owner, { storeId: ctx.storeA.id })
      expect(await apply(id, ShipmentStatus.PICKED_UP, { id: 'n', at: new Date('nonsense') })).toBe(
        IGNORED
      )
      expect(
        await apply(id, ShipmentStatus.PICKED_UP, {
          id: 'o',
          at: new Date(Date.now() - 30 * DAY_MS)
        })
      ).toBe(STORED)
      expect(await statusOf(id)).toBe(ShipmentStatus.LABEL_CREATED)
    })
  })

  describe('the poll', () => {
    // A guide of the fake carrier that is on its way
    async function polled(status: ShipmentStatus = ShipmentStatus.LABEL_CREATED) {
      const connection = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        carrierId: CarrierId.FORZA
      })
      const order = await createOrder(owner, { storeId: ctx.storeA.id, status: 'CONFIRMED' })
      const guideNumber = `F-${randomUUID().slice(0, 8)}`
      const shipment = await owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: order.id,
          connectionId: connection.id,
          serviceCode: connection.serviceCode,
          shippingPayer: ShippingPayer.SENDER,
          currency: 'USD',
          status,
          guideNumber,
          idempotencyKey: `poll-${randomUUID()}`,
          createdBy: 'system'
        },
        select: { id: true }
      })
      const orderRow = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
      forza.state.guides.set(guideNumber, {
        guideNumber,
        providerShipmentId: `P-${guideNumber}`,
        reference: orderRow.orderNumber,
        idempotencyKey: `poll-${guideNumber}`,
        voided: false,
        pickupRef: null,
        rawStatus: 'created'
      })
      return { shipmentId: shipment.id, connectionId: connection.id, guideNumber }
    }
    const poll = (connectionId: string) =>
      poller.poll(ctx.storeA.id, connectionId, { includeOld: false })

    it('asks the carrier and applies what it says through the same engine, once', async () => {
      const { shipmentId, connectionId, guideNumber } = await polled()
      forza.setRawStatus(guideNumber, 'picked')
      expect(await poll(connectionId)).toMatchObject({ asked: 1, applied: 1 })
      expect(await statusOf(shipmentId)).toBe(ShipmentStatus.PICKED_UP)
      // The same answer again changes nothing
      expect(await poll(connectionId)).toMatchObject({ applied: 0, duplicate: 1 })
      forza.setRawStatus(guideNumber, 'delivered')
      expect(await poll(connectionId)).toMatchObject({ applied: 1 })
      expect(await statusOf(shipmentId)).toBe(ShipmentStatus.DELIVERED)
      // A delivered package is not asked about any more
      expect(await poll(connectionId)).toMatchObject({ asked: 0 })
    })

    it('leaves a status it cannot read alone', async () => {
      const { shipmentId, connectionId, guideNumber } = await polled()
      forza.setRawStatus(guideNumber, 'info')
      expect(await poll(connectionId)).toMatchObject({ asked: 1, applied: 0, unreadable: 1 })
      expect(await statusOf(shipmentId)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('does not ask a connection that was disconnected, and does not ask for packages of another store', async () => {
      const { shipmentId, connectionId } = await polled()
      forza.state.calls.length = 0
      expect(await poller.poll(ctx.storeB.id, connectionId, { includeOld: false })).toMatchObject({
        asked: 0
      })
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { status: CarrierConnectionStatus.DISABLED }
      })
      expect(await poll(connectionId)).toMatchObject({ asked: 0 })
      expect(forza.callsTo('fetchStatus')).toHaveLength(0)
      expect(await statusOf(shipmentId)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('asks the packages older than two weeks only in the daily run', async () => {
      const { shipmentId, connectionId, guideNumber } = await polled()
      await owner.shipment.update({
        where: { id: shipmentId },
        data: { createdAt: new Date(Date.now() - 20 * DAY_MS) }
      })
      forza.setRawStatus(guideNumber, 'picked')
      // The carrier's event is dated now, before the guide existed on paper: only the daily run reads it
      expect(await poll(connectionId)).toMatchObject({ asked: 0 })
      expect(await poller.poll(ctx.storeA.id, connectionId, { includeOld: true })).toMatchObject({
        asked: 1,
        applied: 1
      })
    })

    it('goes on after a carrier that fails, and says so', async () => {
      const { shipmentId, connectionId } = await polled()
      const failing = jest
        .spyOn(forza.plugin as Required<typeof forza.plugin>, 'fetchStatus')
        .mockRejectedValue(new Error('down'))
      try {
        expect(await poll(connectionId)).toMatchObject({ asked: 1, failed: 1, applied: 0 })
      } finally {
        failing.mockRestore()
      }
      expect(await statusOf(shipmentId)).toBe(ShipmentStatus.LABEL_CREATED)
    })
  })

  describe('the schedule', () => {
    function scheduler() {
      const queue = new CapturedQueue()
      const instance = new ShipmentPollScheduler(
        {} as never,
        queue as never,
        prisma,
        app.get(CarrierRegistry, { strict: false }),
        quietLogger
      )
      return { queue, instance }
    }
    // A moment on the first tick of a bucket of fifteen minutes (the default interval), and one on the last
    const at = (minuteOfBucket: number) =>
      new Date(Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000 + minuteOfBucket * 60_000)

    it('queues a poll for a connection with packages on their way, once per bucket of its interval', async () => {
      const connection = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        carrierId: CarrierId.FORZA
      })
      const order = await createOrder(owner, { storeId: ctx.storeA.id, status: 'CONFIRMED' })
      await owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: order.id,
          connectionId: connection.id,
          serviceCode: connection.serviceCode,
          shippingPayer: ShippingPayer.SENDER,
          currency: 'USD',
          status: ShipmentStatus.IN_TRANSIT,
          guideNumber: `F-${randomUUID().slice(0, 8)}`,
          idempotencyKey: `sched-${randomUUID()}`,
          createdBy: 'system'
        }
      })
      const { queue, instance } = scheduler()
      const first = await instance.enqueueDue(at(0))
      const mine = () =>
        queue.jobs.filter(
          job => (job.data as { connectionId: string }).connectionId === connection.id
        )
      expect(first).toBeGreaterThanOrEqual(1)
      expect(mine()).toHaveLength(1)
      expect(mine()[0]?.name).toBe(JobNames.POLL_SHIPMENT_STATUS)
      // The tick ten minutes later is not the first of the bucket: nothing for this connection
      const before = mine().length
      await instance.enqueueDue(at(10))
      expect(mine()).toHaveLength(before)
      // Two runs of the first tick are one job: the same id
      await instance.enqueueDue(at(0))
      const ids = mine().map(job => job.opts?.jobId)
      expect(new Set(ids).size).toBe(1)
      expect(ids[0]).toBe(
        pollShipmentStatusJobId(connection.id, Math.floor(at(0).getTime() / 60_000 / 15))
      )
      expect(QueueNames.HEAVY_PROCESSING).toBeDefined()
    })

    it('queues the daily run of the old packages as a job of its own, whatever the interval of the connection', async () => {
      const connection = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        carrierId: CarrierId.FORZA
      })
      const order = await createOrder(owner, { storeId: ctx.storeA.id, status: 'CONFIRMED' })
      await owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: order.id,
          connectionId: connection.id,
          serviceCode: connection.serviceCode,
          shippingPayer: ShippingPayer.SENDER,
          currency: 'USD',
          status: ShipmentStatus.RETURNING,
          guideNumber: `F-${randomUUID().slice(0, 8)}`,
          idempotencyKey: `old-${randomUUID()}`,
          createdBy: 'system'
        }
      })
      await owner.carrierConnection.update({
        where: { id: connection.id },
        data: { pollIntervalMinutes: 25 }
      })
      const { queue, instance } = scheduler()
      // 04:00 UTC, a minute that is not the first tick of a bucket of twenty-five minutes (the package coming back is polled too)
      const day = new Date(Date.UTC(2026, 10, 12, 4, 0))
      await instance.enqueueDue(day)
      await instance.enqueueDue(day)
      const mine = queue.jobs.filter(
        job => (job.data as { connectionId: string }).connectionId === connection.id
      )
      const old = mine.filter(job => (job.data as { includeOld: boolean }).includeOld)
      expect(old).toHaveLength(2)
      expect(new Set(old.map(job => job.opts?.jobId)).size).toBe(1)
      expect(old[0]?.opts?.jobId).toContain('old-2026-11-12')
      // The ordinary poll of the bucket, when its turn has come, is a different job: the old run never takes its id
      const ordinary = mine.filter(job => !(job.data as { includeOld: boolean }).includeOld)
      expect(new Set(ordinary.map(job => job.opts?.jobId)).size).toBeLessThanOrEqual(1)
      for (const job of ordinary) expect(job.opts?.jobId).not.toContain('-old-')
    })

    it('never queues a connection that was disconnected or has no package on its way', async () => {
      const { id, connectionId } = await createShipment(owner, {
        storeId: ctx.storeA.id,
        status: ShipmentStatus.DELIVERED
      })
      expect(id).toBeDefined()
      const { queue, instance } = scheduler()
      await instance.enqueueDue(at(0))
      expect(
        queue.jobs.some(job => (job.data as { connectionId: string }).connectionId === connectionId)
      ).toBe(false)
    })
  })
})
