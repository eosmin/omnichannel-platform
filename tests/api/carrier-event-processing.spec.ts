import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Counter, Registry } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CarrierConnectionStatus,
  CarrierEventOutcomes,
  CarrierId,
  type CarrierIdType,
  ShipmentEventSource,
  ShipmentStatus,
  ShippingPayer,
  ShippingPlugin
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { MetricNames } from '@platform/core/metrics'
import { JobNames, QueueNames } from '@platform/core/queues'
import { ShipmentReplayer, ShipmentStatusEngine, ShipmentWrites } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import {
  CarrierEventApplier,
  CarrierEventHandled
} from '../../apps/worker/src/carriers/carrier-event-applier.service'
import { CarrierEventReplay } from '../../apps/worker/src/carriers/carrier-event-replay.service'
import { CarrierEventResolver } from '../../apps/worker/src/carriers/carrier-event-resolver.service'
import { buildFakeCarrier, createOrder, FAKE_CARRIER_API_KEY, type FakeCarrier } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const CREATED = 201

const noise = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

// What the worker does with an event of a carrier (TDD_17 §4.9, §4.17, Step 4.8 PR C2c): the webhook that arrives twice or out of
// order changes nothing, a code the plugin does not know is kept once and its lines are applied in order when the owner maps it,
// and nothing here reaches a shipment of another connection or store.
describe('What the worker makes of what a carrier says', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let applier: CarrierEventApplier
  let replay: CarrierEventReplay
  let unknown: Counter<string>
  let counter = 0
  let fakeForza: FakeCarrier
  let fakeC807: FakeCarrier
  const told: { connectionId: string; providerCode: string }[] = []
  const moved: { shipmentId: string; to: string; replay?: boolean }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const registry = app.get(CarrierRegistry, { strict: false })
    fakeForza = buildFakeCarrier({ id: CarrierId.FORZA, webhook: true, fetchStatus: true })
    // C807 signs nothing: its webhook proves a shared secret only, so a delivery is asked about before it is believed
    fakeC807 = buildFakeCarrier({
      id: CarrierId.C807,
      webhook: true,
      fetchStatus: true,
      sharedSecret: true
    })
    registry.register(fakeForza.plugin)
    registry.register(fakeC807.plugin)

    for (const [actor, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const installed = await api(app, actor, store)
        .post(ApiRoutes.plugins.install)
        .send({ pluginId: ShippingPlugin.ID })
      expect(installed.status).toBe(CREATED)
    }

    const prisma = app.get(PrismaService, { strict: false })
    const events = app.get(DomainEvents, { strict: false })
    const writes = new ShipmentWrites(events)
    const engine = new ShipmentStatusEngine(prisma, writes)
    const resolver = new CarrierEventResolver(prisma, noise as unknown as PinoLogger)
    unknown = new Counter({
      name: MetricNames.SHIPMENT_UNKNOWN_STATUS_TOTAL,
      help: 'test',
      labelNames: ['carrier'],
      registers: [new Registry()]
    })
    applier = new CarrierEventApplier(
      prisma,
      resolver,
      engine,
      writes,
      events,
      registry,
      app.get(CredentialCipher, { strict: false }),
      unknown,
      noise as unknown as PinoLogger
    )
    replay = new CarrierEventReplay(
      prisma,
      resolver,
      applier,
      new ShipmentReplayer(prisma, writes),
      noise as unknown as PinoLogger
    )
    const bus = app.get(EventEmitter2)
    bus.on(
      Events.CARRIER_STATUS_UNMAPPED,
      (payload: { connectionId: string; providerCode: string }) => told.push(payload)
    )
    bus.on(
      Events.SHIPMENT_STATUS_CHANGED,
      (payload: { shipmentId: string; to: string; replay?: boolean }) => moved.push(payload)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    told.length = 0
    moved.length = 0
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const connect = async (carrierId: CarrierIdType = CarrierId.FORZA, as = asAdmin) => {
    const response = await as()
      .post(ApiRoutes.carriers.create)
      .send({
        carrierId,
        credentials: { apiKey: FAKE_CARRIER_API_KEY },
        displayName: `${prefix}-c-${(counter += 1)}`
      })
    expect(response.status).toBe(CREATED)
    return (response.body as { id: string }).id
  }
  // A guide of the connection, in the status it is in, written as the owner
  async function shipmentOf(
    connectionId: string,
    over: { storeId?: string; status?: ShipmentStatus; guide?: string; providerId?: string } = {}
  ) {
    const storeId = over.storeId ?? ctx.storeA.id
    const order = await createOrder(owner, { storeId, status: 'CONFIRMED' })
    const orderRow = await owner.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { orderNumber: true }
    })
    const guideNumber = over.guide ?? `G-${randomUUID()}`
    const status = over.status ?? ShipmentStatus.LABEL_CREATED
    const shipment = await owner.shipment.create({
      data: {
        storeId,
        orderId: order.id,
        connectionId,
        serviceCode: 'standard',
        shippingPayer: ShippingPayer.SENDER,
        currency: 'USD',
        status,
        guideNumber,
        ...(over.providerId === undefined ? {} : { providerShipmentId: over.providerId }),
        idempotencyKey: `built-${randomUUID()}`,
        createdBy: 'system',
        createdAt: new Date('2026-11-01T00:00:00.000Z')
      },
      select: { id: true }
    })
    await owner.shipmentEvent.create({
      data: {
        storeId,
        shipmentId: shipment.id,
        status,
        occurredAt: new Date('2026-11-01T00:00:00.000Z'),
        source: ShipmentEventSource.SYSTEM
      }
    })
    return { id: shipment.id, guideNumber, orderNumber: orderRow.orderNumber }
  }
  const job = (
    connectionId: string,
    names: { guideNumber?: string; providerShipmentId?: string; reference?: string },
    rawStatus: string,
    over: {
      id?: string
      at?: string
      status?: ShipmentStatus | null
      rawReason?: string
      storeId?: string
    } = {}
  ) => ({
    storeId: over.storeId ?? ctx.storeA.id,
    connectionId,
    receivedAt: new Date().toISOString(),
    event: {
      ...(over.id === undefined ? {} : { providerEventId: over.id }),
      status: over.status === undefined ? null : over.status,
      rawStatus,
      ...(over.rawReason === undefined ? {} : { rawReason: over.rawReason }),
      occurredAt: over.at ?? '2026-11-02T10:00:00.000Z',
      ...names
    }
  })
  const apply = (j: ReturnType<typeof job>) => applier.apply(j, ShipmentEventSource.WEBHOOK)
  const statusOf = async (shipmentId: string) =>
    (
      await owner.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        select: { status: true }
      })
    ).status
  const lines = (shipmentId: string) =>
    owner.shipmentEvent.findMany({
      where: { shipmentId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { status: true, rawStatus: true, providerEventId: true, source: true }
    })
  const put = (id: string, code: string, status: ShipmentStatus | null) =>
    asAdmin()
      .put(ApiRoutes.carriers.statusMappingByCode(id, encodeURIComponent(code)))
      .send({ status })
  const settle = () => new Promise(resolve => setTimeout(resolve, 150))

  describe('a duplicate or an event out of order', () => {
    it('applies an event once, whatever number of times the carrier sends it', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      const event = job(connectionId, { guideNumber: shipment.guideNumber }, 'picked', {
        id: 'e-1',
        status: ShipmentStatus.PICKED_UP
      })

      expect(await apply(event)).toBe(CarrierEventOutcomes.APPLIED)
      expect(await apply(event)).toBe(CarrierEventOutcomes.DUPLICATE)
      expect(await apply(event)).toBe(CarrierEventOutcomes.DUPLICATE)

      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.PICKED_UP)
      expect((await lines(shipment.id)).filter(l => l.providerEventId === 'e-1')).toHaveLength(1)
      await settle()
      expect(moved.filter(m => m.shipmentId === shipment.id)).toHaveLength(1)
    })

    it('dedupes on status and moment when the carrier sends no id of its own', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      const event = job(connectionId, { guideNumber: shipment.guideNumber }, 'transit', {
        status: ShipmentStatus.IN_TRANSIT
      })

      expect(await apply(event)).toBe(CarrierEventOutcomes.APPLIED)
      expect(await apply(event)).toBe(CarrierEventOutcomes.DUPLICATE)

      expect((await lines(shipment.id)).filter(l => l.status === 'in_transit')).toHaveLength(1)
    })

    it('keeps an older event in the history and does not move the shipment back', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      const names = { guideNumber: shipment.guideNumber }
      await apply(
        job(connectionId, names, 'delivered', {
          id: 'late',
          at: '2026-11-03T10:00:00.000Z',
          status: ShipmentStatus.DELIVERED
        })
      )

      const outcome = await apply(
        job(connectionId, names, 'transit', {
          id: 'early',
          at: '2026-11-02T10:00:00.000Z',
          status: ShipmentStatus.IN_TRANSIT
        })
      )

      expect(outcome).toBe(CarrierEventOutcomes.STORED)
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.DELIVERED)
      expect((await lines(shipment.id)).map(l => l.providerEventId)).toContain('early')
    })

    it('counts a failed attempt each time it is a new one, and not when it is told again', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      const names = { guideNumber: shipment.guideNumber }
      const fail = (id: string, at: string) =>
        job(connectionId, names, 'failed', { id, at, status: ShipmentStatus.FAILED_ATTEMPT })

      await apply(fail('f-1', '2026-11-02T10:00:00.000Z'))
      await apply(fail('f-1', '2026-11-02T10:00:00.000Z'))
      await apply(fail('f-2', '2026-11-03T10:00:00.000Z'))

      const row = await owner.shipment.findUniqueOrThrow({
        where: { id: shipment.id },
        select: { failedAttempts: true, status: true }
      })
      expect(row).toEqual({ failedAttempts: 2, status: ShipmentStatus.FAILED_ATTEMPT })
    })
  })

  describe('which shipment an event is about', () => {
    it('finds it by the guide number, the id of the carrier, or the order number', async () => {
      const connectionId = await connect()
      const byGuide = await shipmentOf(connectionId)
      const byProvider = await shipmentOf(connectionId, { providerId: `prov-${randomUUID()}` })
      const byOrder = await shipmentOf(connectionId)
      const picked = (names: object, id: string) =>
        job(connectionId, names, 'picked', { id, status: ShipmentStatus.PICKED_UP })

      await apply(picked({ guideNumber: byGuide.guideNumber }, 'a'))
      const provider = await owner.shipment.findUniqueOrThrow({
        where: { id: byProvider.id },
        select: { providerShipmentId: true }
      })
      await apply(picked({ providerShipmentId: provider.providerShipmentId ?? '' }, 'b'))
      await apply(picked({ reference: byOrder.orderNumber }, 'c'))

      for (const shipment of [byGuide, byProvider, byOrder]) {
        expect(await statusOf(shipment.id)).toBe(ShipmentStatus.PICKED_UP)
      }
    })

    it('never takes the guide of another connection or another store, though it prints the same number', async () => {
      const connectionId = await connect()
      const other = await connect()
      const sameNumber = `SAME-${randomUUID()}`
      const mine = await shipmentOf(connectionId, { guide: sameNumber })
      const theirs = await shipmentOf(other, { guide: sameNumber })

      await apply(
        job(connectionId, { guideNumber: sameNumber }, 'picked', {
          id: 'x',
          status: ShipmentStatus.PICKED_UP
        })
      )

      expect(await statusOf(mine.id)).toBe(ShipmentStatus.PICKED_UP)
      expect(await statusOf(theirs.id)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('does nothing for an event of a store that is not the one of the connection', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)

      const outcome = await apply(
        job(connectionId, { guideNumber: shipment.guideNumber }, 'picked', {
          id: 'x',
          status: ShipmentStatus.PICKED_UP,
          storeId: ctx.storeB.id
        })
      )

      expect(outcome).toBe(CarrierEventHandled.IGNORED)
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('does nothing for a guide nobody has, or for an order number that names two live packages', async () => {
      const connectionId = await connect()
      const first = await shipmentOf(connectionId)
      const second = await owner.shipment.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: (await owner.shipment.findUniqueOrThrow({ where: { id: first.id } })).orderId,
          connectionId,
          // A second origin: the order ships from two warehouses, so two guides are alive at once
          originWarehouseId: ctx.warehouseA.id,
          serviceCode: 'standard',
          shippingPayer: ShippingPayer.SENDER,
          currency: 'USD',
          status: ShipmentStatus.LABEL_CREATED,
          guideNumber: `G-${randomUUID()}`,
          idempotencyKey: `built-${randomUUID()}`,
          createdBy: 'system'
        },
        select: { id: true }
      })
      const picked = (names: object) =>
        job(connectionId, names, 'picked', { id: randomUUID(), status: ShipmentStatus.PICKED_UP })

      expect(await apply(picked({ guideNumber: 'NOBODY' }))).toBe(CarrierEventHandled.NOT_FOUND)
      // A stale guide is not rescued by the order number it carries
      expect(await apply(picked({ guideNumber: 'NOBODY', reference: first.orderNumber }))).toBe(
        CarrierEventHandled.NOT_FOUND
      )
      expect(await apply(picked({ reference: first.orderNumber }))).toBe(
        CarrierEventOutcomes.IGNORED
      )

      expect(await statusOf(first.id)).toBe(ShipmentStatus.LABEL_CREATED)
      expect(await statusOf(second.id)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('drops what a connection that was let go says', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      await asAdmin().post(ApiRoutes.carriers.disconnect(connectionId))

      const outcome = await apply(
        job(connectionId, { guideNumber: shipment.guideNumber }, 'picked', {
          id: 'x',
          status: ShipmentStatus.PICKED_UP
        })
      )

      expect(outcome).toBe(CarrierEventOutcomes.IGNORED)
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.LABEL_CREATED)
    })
  })

  describe('what the code means', () => {
    it('lets the mapping of the connection win over what the plugin says', async () => {
      const connectionId = await connect()
      await put(connectionId, 'transit', ShipmentStatus.PICKED_UP)
      const shipment = await shipmentOf(connectionId)

      await apply(
        job(connectionId, { guideNumber: shipment.guideNumber }, 'Transit', {
          id: 'x',
          status: ShipmentStatus.IN_TRANSIT
        })
      )

      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.PICKED_UP)
    })

    it('keeps a code the owner chose to ignore with no effect, and not as unknown', async () => {
      const connectionId = await connect()
      await put(connectionId, 'transit', null)
      const shipment = await shipmentOf(connectionId)
      const before = (await unknown.get()).values.length

      const outcome = await apply(
        job(connectionId, { guideNumber: shipment.guideNumber }, 'TRANSIT', {
          id: 'x',
          status: ShipmentStatus.IN_TRANSIT
        })
      )

      expect(outcome).toBe(CarrierEventOutcomes.STORED)
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.LABEL_CREATED)
      expect(
        (await lines(shipment.id)).some(l => l.providerEventId === 'x' && l.status === null)
      ).toBe(true)
      expect(await owner.carrierUnmappedStatus.count({ where: { connectionId } })).toBe(0)
      expect((await unknown.get()).values.length).toBe(before)
      await settle()
      expect(told).toHaveLength(0)
    })

    it('records a code nobody mapped once, however many events and shipments bring it, and tells the owner once', async () => {
      const connectionId = await connect()
      const one = await shipmentOf(connectionId)
      const two = await shipmentOf(connectionId)
      const unmapped = (shipment: { guideNumber: string }, id: string, at: string) =>
        job(connectionId, { guideNumber: shipment.guideNumber }, 'En Bodega', { id, at })

      expect(await apply(unmapped(one, 'u-1', '2026-11-02T10:00:00.000Z'))).toBe(
        CarrierEventOutcomes.STORED
      )
      // The carrier sends it again, as carriers do
      expect(await apply(unmapped(one, 'u-1', '2026-11-02T10:00:00.000Z'))).toBe(
        CarrierEventOutcomes.DUPLICATE
      )
      await apply(unmapped(one, 'u-2', '2026-11-02T11:00:00.000Z'))
      await apply(unmapped(two, 'u-3', '2026-11-02T12:00:00.000Z'))

      const rows = await owner.carrierUnmappedStatus.findMany({ where: { connectionId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        storeId: ctx.storeA.id,
        providerCode: 'en bodega',
        sampleRawStatus: 'En Bodega',
        occurrences: 3,
        resolvedAt: null
      })
      await settle()
      expect(told.filter(t => t.connectionId === connectionId)).toEqual([
        { storeId: ctx.storeA.id, connectionId, providerCode: 'en bodega' }
      ])
      expect(await statusOf(one.id)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('does not tell the first sighting twice when a job is tried again', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      const event = job(connectionId, { guideNumber: shipment.guideNumber }, 'zzz', { id: 'same' })

      await apply(event)
      await apply(event)
      await apply(event)

      await settle()
      expect(told.filter(t => t.connectionId === connectionId)).toHaveLength(1)
      expect(
        (await owner.carrierUnmappedStatus.findFirstOrThrow({ where: { connectionId } }))
          .occurrences
      ).toBe(1)
    })
  })

  describe('mapping a code that was unknown', () => {
    it('applies the events kept under it, in order, with no message to the customer, and only once', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      const names = { guideNumber: shipment.guideNumber }
      // Three kept events, sent out of order: bodega, then the carrier says it is on its way, then it was delivered
      await apply(job(connectionId, names, 'zz-out', { id: 'k-2', at: '2026-11-02T12:00:00.000Z' }))
      await apply(
        job(connectionId, names, 'zz-picked', { id: 'k-1', at: '2026-11-02T10:00:00.000Z' })
      )
      await apply(
        job(connectionId, names, 'zz-done', { id: 'k-3', at: '2026-11-03T09:00:00.000Z' })
      )
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.LABEL_CREATED)
      await settle()
      moved.length = 0

      await put(connectionId, 'zz-picked', ShipmentStatus.PICKED_UP)
      await put(connectionId, 'zz-out', ShipmentStatus.OUT_FOR_DELIVERY)
      const queuedJobs = queueOf(app, QueueNames.HEAVY_PROCESSING)
        .jobs.filter(j => j.name === JobNames.REPROCESS_CARRIER_EVENTS)
        .map(j => j.data as { connectionId: string; providerCode: string })
        .filter(j => j.connectionId === connectionId)
      expect(queuedJobs.map(j => j.providerCode)).toEqual(['zz-picked', 'zz-out'])

      const first = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-picked'
      })
      const second = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-out'
      })
      const again = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-out'
      })

      expect(first.applied).toBe(1)
      expect(second.applied).toBe(1)
      expect(again.read).toBe(0)
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.OUT_FOR_DELIVERY)
      await settle()
      const mine = moved.filter(m => m.shipmentId === shipment.id)
      expect(mine.map(m => m.to)).toEqual([
        ShipmentStatus.PICKED_UP,
        ShipmentStatus.OUT_FOR_DELIVERY
      ])
      // Nobody outside the team is written to about a package that may have arrived days ago
      expect(mine.every(m => m.replay === true)).toBe(true)
      // One line of the history per event, now with its status; the one still unknown keeps none
      const history = await lines(shipment.id)
      expect(history.filter(l => l.providerEventId === 'k-1')).toEqual([
        expect.objectContaining({ status: ShipmentStatus.PICKED_UP })
      ])
      expect(history.filter(l => l.providerEventId === 'k-3')).toEqual([
        expect.objectContaining({ status: null })
      ])
      expect(
        (
          await owner.carrierUnmappedStatus.findMany({
            where: { connectionId, providerCode: { in: ['zz-picked', 'zz-out'] } }
          })
        ).every(row => row.resolvedAt !== null)
      ).toBe(true)
    })

    it('says how many shipments wait under a code, and queues the replay for a mapping and for a default restored', async () => {
      const connectionId = await connect()
      const one = await shipmentOf(connectionId)
      const two = await shipmentOf(connectionId)
      for (const [shipment, id] of [
        [one, 'w-1'],
        [one, 'w-2'],
        [two, 'w-3']
      ] as const) {
        await apply(job(connectionId, { guideNumber: shipment.guideNumber }, 'zz-wait', { id }))
      }
      const listed = await asAdmin().get(ApiRoutes.carriers.unmappedStatuses(connectionId))
      expect((listed.body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({ providerCode: 'zz-wait', occurrences: 3, shipmentsWaiting: 2 })
      ])
      const replays = () =>
        queueOf(app, QueueNames.HEAVY_PROCESSING)
          .jobs.filter(j => j.name === JobNames.REPROCESS_CARRIER_EVENTS)
          .map(j => j.data as { connectionId: string; providerCode: string })
          .filter(j => j.connectionId === connectionId)

      // An ignore gives the lines no effect: nothing to replay
      await put(connectionId, 'zz-wait', null)
      expect(replays()).toHaveLength(0)
      await put(connectionId, 'zz-wait', ShipmentStatus.PICKED_UP)
      expect(replays().map(j => j.providerCode)).toEqual(['zz-wait'])

      // The default of the plugin for a code of its catalog applies to what was kept, as a mapping does
      await put(connectionId, 'transit', null)
      await asAdmin().delete(ApiRoutes.carriers.statusMappingByCode(connectionId, 'transit'))
      expect(replays().map(j => j.providerCode)).toEqual(['zz-wait', 'transit'])
    })

    it('gives the status to a line a later event already passed, and moves nothing', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      const names = { guideNumber: shipment.guideNumber }
      await apply(job(connectionId, names, 'zz-old', { id: 'o-1', at: '2026-11-02T10:00:00.000Z' }))
      await apply(
        job(connectionId, names, 'delivered', {
          id: 'o-2',
          at: '2026-11-03T10:00:00.000Z',
          status: ShipmentStatus.DELIVERED
        })
      )
      await put(connectionId, 'zz-old', ShipmentStatus.PICKED_UP)

      const report = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-old'
      })

      expect(report).toMatchObject({ read: 1, applied: 0, stored: 1 })
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.DELIVERED)
      expect((await lines(shipment.id)).find(l => l.providerEventId === 'o-1')?.status).toBe(
        ShipmentStatus.PICKED_UP
      )
    })

    it('maps one reason of a carrier without touching the others, and the plain code covers the rest', async () => {
      const connectionId = await connect()
      const one = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      const two = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      await apply(
        job(connectionId, { guideNumber: one.guideNumber }, 'zz-fail', {
          id: 'r-1',
          rawReason: '115'
        })
      )
      await apply(
        job(connectionId, { guideNumber: two.guideNumber }, 'zz-fail', {
          id: 'r-2',
          rawReason: '120'
        })
      )

      await put(connectionId, 'zz-fail:115', ShipmentStatus.RETURNING)
      await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-fail:115'
      })

      expect(await statusOf(one.id)).toBe(ShipmentStatus.RETURNING)
      expect(await statusOf(two.id)).toBe(ShipmentStatus.OUT_FOR_DELIVERY)

      // The plain code then answers every reason that has no mapping of its own
      await put(connectionId, 'zz-fail', ShipmentStatus.FAILED_ATTEMPT)
      await replay.reprocess({ storeId: ctx.storeA.id, connectionId, providerCode: 'zz-fail' })
      expect(await statusOf(two.id)).toBe(ShipmentStatus.FAILED_ATTEMPT)
      expect(await statusOf(one.id)).toBe(ShipmentStatus.RETURNING)
    })

    it('settles a line once when the carrier told the same event again after the code was mapped', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      const event = job(connectionId, { guideNumber: shipment.guideNumber }, 'zz-miss', {
        at: '2026-11-02T10:00:00.000Z'
      })
      await apply(event)
      await put(connectionId, 'zz-miss', ShipmentStatus.FAILED_ATTEMPT)
      // The carrier sends it again before the replay runs: it is applied as a new event
      expect(await apply(event)).toBe(CarrierEventOutcomes.APPLIED)

      const report = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-miss'
      })

      expect(report.applied).toBe(0)
      const row = await owner.shipment.findUniqueOrThrow({
        where: { id: shipment.id },
        select: { failedAttempts: true }
      })
      expect(row.failedAttempts).toBe(1)
      expect(
        (await lines(shipment.id)).filter(l => l.rawStatus === 'zz-miss' && l.status === null)
      ).toHaveLength(0)
      expect((await lines(shipment.id)).filter(l => l.rawStatus === 'zz-miss')).toHaveLength(1)
    })

    it('does not step a package back to an older line, though the table would allow it', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      const names = { guideNumber: shipment.guideNumber }
      await apply(
        job(connectionId, names, 'zz-older', { id: 'b-1', at: '2026-11-02T10:00:00.000Z' })
      )
      await apply(
        job(connectionId, names, 'failed', {
          id: 'b-2',
          at: '2026-11-02T14:00:00.000Z',
          status: ShipmentStatus.FAILED_ATTEMPT
        })
      )
      await put(connectionId, 'zz-older', ShipmentStatus.OUT_FOR_DELIVERY)

      const report = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-older'
      })

      expect(report).toMatchObject({ applied: 0, stored: 1 })
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.FAILED_ATTEMPT)
    })

    it('goes on with the other lines when one of them cannot be settled', async () => {
      const connectionId = await connect()
      const one = await shipmentOf(connectionId)
      const two = await shipmentOf(connectionId)
      for (const [shipment, id] of [
        [one, 'p-1'],
        [two, 'p-2']
      ] as const) {
        await apply(job(connectionId, { guideNumber: shipment.guideNumber }, 'zz-poison', { id }))
      }
      await put(connectionId, 'zz-poison', ShipmentStatus.PICKED_UP)
      const replayer = (replay as unknown as { replayer: ShipmentReplayer }).replayer
      const original = replayer.replay.bind(replayer)
      const spy = jest
        .spyOn(replayer, 'replay')
        .mockImplementationOnce(() => Promise.reject(new Error('lock timeout')))
        .mockImplementation(original)
      try {
        const report = await replay.reprocess({
          storeId: ctx.storeA.id,
          connectionId,
          providerCode: 'zz-poison'
        })
        expect(report).toMatchObject({ read: 2, failed: 1, applied: 1 })
      } finally {
        spy.mockRestore()
      }
    })

    it('leaves alone the lines of another connection and another store that wear the same code', async () => {
      const mine = await connect()
      const theirs = await connect()
      const own = await shipmentOf(mine)
      const foreign = await shipmentOf(theirs)
      for (const [connectionId, shipment] of [
        [mine, own],
        [theirs, foreign]
      ] as const) {
        await apply(
          job(connectionId, { guideNumber: shipment.guideNumber }, 'zz-shared', {
            id: `s-${connectionId}`
          })
        )
      }
      await put(mine, 'zz-shared', ShipmentStatus.PICKED_UP)

      await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId: mine,
        providerCode: 'zz-shared'
      })
      // A job that names another store with the id of this connection reads nothing of it
      const strange = await replay.reprocess({
        storeId: ctx.storeB.id,
        connectionId: mine,
        providerCode: 'zz-shared'
      })

      expect(strange.read).toBe(0)
      expect(await statusOf(own.id)).toBe(ShipmentStatus.PICKED_UP)
      expect(await statusOf(foreign.id)).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('does nothing for a connection that was let go', async () => {
      const connectionId = await connect()
      const shipment = await shipmentOf(connectionId)
      await apply(
        job(connectionId, { guideNumber: shipment.guideNumber }, 'zz-gone', { id: 'g-1' })
      )
      await put(connectionId, 'zz-gone', ShipmentStatus.PICKED_UP)
      await owner.carrierConnection.update({
        where: { id: connectionId },
        data: { status: CarrierConnectionStatus.DISABLED }
      })

      const report = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-gone'
      })

      expect(report.read).toBe(0)
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.LABEL_CREATED)
    })
  })

  describe('a carrier that only shares a secret', () => {
    it('applies a delivery only if the carrier itself says the package was delivered', async () => {
      const connectionId = await connect(CarrierId.C807)
      const shipment = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      const claim = job(connectionId, { guideNumber: shipment.guideNumber }, 'delivered', {
        id: 'd-1',
        status: ShipmentStatus.DELIVERED
      })
      // The carrier's own books say it is still on its way: whoever pushed the claim knew the secret and nothing else
      fakeC807.state.guides.set(shipment.guideNumber, {
        guideNumber: shipment.guideNumber,
        providerShipmentId: 'p',
        reference: shipment.orderNumber,
        idempotencyKey: 'k',
        voided: false,
        pickupRef: null,
        rawStatus: 'out'
      })

      expect(await apply(claim)).toBe('unconfirmed')
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.OUT_FOR_DELIVERY)

      fakeC807.setRawStatus(shipment.guideNumber, 'delivered')

      expect(await apply(claim)).toBe(CarrierEventOutcomes.APPLIED)
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.DELIVERED)
    })

    it('applies the other statuses with no question to the carrier', async () => {
      const connectionId = await connect(CarrierId.C807)
      const shipment = await shipmentOf(connectionId)
      const before = fakeC807.callsTo('fetchStatus').length

      expect(
        await apply(
          job(connectionId, { guideNumber: shipment.guideNumber }, 'picked', {
            id: 'p-1',
            status: ShipmentStatus.PICKED_UP
          })
        )
      ).toBe(CarrierEventOutcomes.APPLIED)

      expect(fakeC807.callsTo('fetchStatus')).toHaveLength(before)
    })

    it('asks before a replay applies a delivery too', async () => {
      const connectionId = await connect(CarrierId.C807)
      const shipment = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      await apply(
        job(connectionId, { guideNumber: shipment.guideNumber }, 'zz-arrived', { id: 'a-1' })
      )
      fakeC807.state.guides.set(shipment.guideNumber, {
        guideNumber: shipment.guideNumber,
        providerShipmentId: 'p2',
        reference: shipment.orderNumber,
        idempotencyKey: 'k2',
        voided: false,
        pickupRef: null,
        rawStatus: 'out'
      })
      await put(connectionId, 'zz-arrived', ShipmentStatus.DELIVERED)

      const report = await replay.reprocess({
        storeId: ctx.storeA.id,
        connectionId,
        providerCode: 'zz-arrived'
      })

      expect(report).toMatchObject({ read: 1, applied: 0, unconfirmed: 1 })
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.OUT_FOR_DELIVERY)
    })

    it('does not ask the carrier about what a poll says: the answer came from its own API', async () => {
      const connectionId = await connect(CarrierId.C807)
      const shipment = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      const before = fakeC807.callsTo('fetchStatus').length

      const outcome = await applier.apply(
        job(connectionId, { guideNumber: shipment.guideNumber }, 'delivered', {
          id: 'poll-1',
          status: ShipmentStatus.DELIVERED
        }),
        ShipmentEventSource.POLL
      )

      expect(outcome).toBe(CarrierEventOutcomes.APPLIED)
      expect(fakeC807.callsTo('fetchStatus')).toHaveLength(before)
    })

    it('applies no closing status when the plugin of the connection is not loaded', async () => {
      const connectionId = await connect(CarrierId.C807)
      const shipment = await shipmentOf(connectionId, { status: ShipmentStatus.OUT_FOR_DELIVERY })
      const registry = app.get(CarrierRegistry, { strict: false })
      const find = jest.spyOn(registry, 'find').mockReturnValue(undefined)
      try {
        const outcome = await apply(
          job(connectionId, { guideNumber: shipment.guideNumber }, 'delivered', {
            id: 'gone-1',
            status: ShipmentStatus.DELIVERED
          })
        )
        expect(outcome).toBe(CarrierEventHandled.UNCONFIRMED)
      } finally {
        find.mockRestore()
      }
      expect(await statusOf(shipment.id)).toBe(ShipmentStatus.OUT_FOR_DELIVERY)
    })
  })
})
