import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  BulkLabelJobStatus,
  BulkOrderOutcomes,
  CarrierId,
  MediaStatus,
  ShippingPlugin
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { type BulkLabelsMergeJob, JobNames, QueueNames } from '@platform/core/queues'
import { MergedLabels, ShippingService } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { BulkLabelsRunner } from '../../apps/worker/src/shipping/bulk-labels-runner.service'
import {
  buildFakeCarrier,
  createCarrierConnection,
  createOrder,
  type FakeCarrier,
  FakeCarrierBehaviors
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { type CapturedQueue, queueOf } from '../helpers/queue'

const CREATED = 201
const ACCEPTED = 202
const BAD_REQUEST = 400
const NOT_FOUND = 404
const CONFLICT = 409

const quietLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as PinoLogger

interface ErrorBody {
  error: { code: string }
}
interface JobBody {
  id: string
  succeeded: number
  failed: number
  results: { orderId: string; outcome: string; errorCode?: string }[] | null
}

const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }
const PLACES = { departmentId: '2', municipalityId: '21' }

// The places of a run of labels (Step 4.15 PR 3, TDD_17 §4.1 and §4.6): a carrier that declares REQUIRES_LOCATION_IDS gets the
// two ids once for the whole batch, judged by the api against what the carrier lists, and the worker sends them in every guide.
// Everything is decided by the capability the fake declares, never by an id.
describe('Bulk labels with the places of the carrier', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let prisma: PrismaService
  let located: FakeCarrier
  let plainFake: FakeCarrier
  let runner: BulkLabelsRunner
  let heavy: CapturedQueue
  let locatedId = ''
  let plainId = ''
  let localId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(CarrierRegistry, { strict: false })
    located = buildFakeCarrier({
      id: CarrierId.FORZA,
      cancel: true,
      fetchStatus: true,
      locations: {
        '': [
          { id: '1', name: 'Ahuachapán' },
          { id: '2', name: 'San Salvador' }
        ],
        '1': [{ id: '11', name: 'Atiquizaya', parentId: '1' }],
        '2': [
          { id: '21', name: 'Soyapango', parentId: '2' },
          { id: '22', name: 'Mejicanos', parentId: '2' }
        ]
      }
    })
    registry.register(located.plugin)
    // A second carrier that asks for no places: a batch planned for both must give places to the first and to no guide of the second
    plainFake = buildFakeCarrier({ id: CarrierId.C807, mode: 'pickup_bound', maxBatchSize: 2 })
    registry.register(plainFake.plugin)
    heavy = queueOf(app, QueueNames.HEAVY_PROCESSING)
    runner = new BulkLabelsRunner(
      prisma,
      app.get(ShippingService, { strict: false }),
      app.get(MergedLabels, { strict: false }),
      registry,
      app.get(DomainEvents, { strict: false }),
      quietLogger
    )
    const installed = await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: ShippingPlugin.ID })
    expect(installed.status).toBe(CREATED)
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    localId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'BP' })).id
    locatedId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.FORZA })
    ).id
    plainId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.C807 })
    ).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    located.state.guides.clear()
    located.state.calls.length = 0
    plainFake.state.guides.clear()
    plainFake.state.calls.length = 0
    located.state.create = FakeCarrierBehaviors.OK
  })
  afterEach(async () => {
    await owner.bulkLabelJob.updateMany({
      where: {
        storeId: { in: [ctx.storeA.id, ctx.storeB.id] },
        status: { in: [BulkLabelJobStatus.QUEUED, BulkLabelJobStatus.RUNNING] }
      },
      data: { status: BulkLabelJobStatus.FAILED, finishedAt: new Date() }
    })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const confirmed = (carrierConnectionId = locatedId) =>
    createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id,
      carrierConnectionId
    })
  const start = (orderIds: string[], body: Record<string, unknown>) =>
    asAdmin()
      .post(ApiRoutes.shipments.bulk)
      .send({ orderIds, ...body })
  const runsOfStore = () => owner.bulkLabelJob.count({ where: { storeId: ctx.storeA.id } })
  const queuedJob = (jobId: string): BulkLabelsMergeJob => {
    const job = heavy.jobs
      .filter(
        queued =>
          queued.name === JobNames.BULK_LABELS_MERGE &&
          (queued.data as BulkLabelsMergeJob).jobId === jobId
      )
      .at(-1)
    if (job === undefined) throw new Error('the run was not queued')
    return job.data as BulkLabelsMergeJob
  }
  // The scan of a label is the worker's: the suite stands in for it, a moment after each label arrives
  const withScan = async <T>(work: () => Promise<T>): Promise<T> => {
    let pending: Promise<unknown> = Promise.resolve()
    const timer = setInterval(() => {
      pending = pending
        .then(() =>
          owner.media.updateMany({
            where: {
              storeId: ctx.storeA.id,
              purpose: 'shipping_label',
              status: MediaStatus.PENDING
            },
            data: { status: MediaStatus.CLEAN }
          })
        )
        .catch(() => undefined)
    }, 25)
    try {
      return await work()
    } finally {
      clearInterval(timer)
      await pending
    }
  }

  it('sends the places of the batch in every guide of the run, and in nothing else', async () => {
    const orders = await Promise.all([confirmed(), confirmed(), confirmed()])
    const response = await start(
      orders.map(order => order.id),
      { connectionId: locatedId, locationIds: PLACES }
    )
    expect(response.status).toBe(ACCEPTED)
    const accepted = response.body as JobBody
    expect(queuedJob(accepted.id).locationIds).toEqual(PLACES)

    await withScan(() =>
      runner.run(queuedJob(accepted.id), false, { scanWaitMs: 3000, scanPollMs: 25 })
    )

    const sent = located.callsTo('createShipment')
    expect(sent).toHaveLength(3)
    for (const call of sent) {
      expect((call.args as { recipient: { locationIds?: unknown } }).recipient.locationIds).toEqual(
        PLACES
      )
    }
    const view = await asAdmin().get(ApiRoutes.shipments.bulkJob(accepted.id))
    const job = view.body as JobBody
    expect(job.succeeded).toBe(3)
    expect(job.results?.every(entry => entry.outcome === BulkOrderOutcomes.CREATED)).toBe(true)
  })

  it('refuses at the request, with no run, a carrier that asks for places and got none', async () => {
    const order = await confirmed()
    const before = await runsOfStore()
    const response = await start([order.id], { connectionId: locatedId })
    expect(response.status).toBe(BAD_REQUEST)
    expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_LOCATION_REQUIRED)
    expect(await runsOfStore()).toBe(before)
  })

  it.each([
    ['a department the carrier does not list', { departmentId: '9', municipalityId: '21' }],
    ['a municipality of another department', { departmentId: '2', municipalityId: '11' }],
    ['a municipality that does not exist', { departmentId: '2', municipalityId: '99' }]
  ])('refuses %s', async (_name, places) => {
    const order = await confirmed()
    const before = await runsOfStore()
    const response = await start([order.id], { connectionId: locatedId, locationIds: places })
    expect(response.status).toBe(BAD_REQUEST)
    expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_LOCATION_REQUIRED)
    expect(await runsOfStore()).toBe(before)
  })

  it('refuses places with no carrier to belong to, and a stray field of a place', async () => {
    const order = await confirmed()
    const alone = await start([order.id], { locationIds: PLACES })
    expect(alone.status).toBe(BAD_REQUEST)
    const stray = await start([order.id], {
      connectionId: locatedId,
      locationIds: { ...PLACES, settlementId: '7' }
    })
    expect(stray.status).toBe(BAD_REQUEST)
  })

  it('takes no places for a carrier that does not ask for them', async () => {
    const order = await confirmed()
    const before = await runsOfStore()
    const response = await start([order.id], { connectionId: localId, locationIds: PLACES })
    expect(response.status).toBe(CONFLICT)
    expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING)
    expect(await runsOfStore()).toBe(before)
  })

  it('does not take the connection of another store, with or without places', async () => {
    const order = await createOrder(owner, { storeId: ctx.storeB.id, status: 'CONFIRMED' })
    const foreign = await asAdminB()
      .post(ApiRoutes.shipments.bulk)
      .send({ orderIds: [order.id], connectionId: locatedId, locationIds: PLACES })
    expect(foreign.status).toBe(NOT_FOUND)
  })

  describe('a run that follows the planned carrier of each order (QA FUNC-H8)', () => {
    it('gives the places of a carrier to its guides and to no guide of another carrier', async () => {
      const [first, second, other] = await Promise.all([
        confirmed(),
        confirmed(),
        confirmed(plainId)
      ])
      const response = await start([first.id, other.id, second.id], {
        locationsByConnection: { [locatedId]: PLACES }
      })
      expect(response.status).toBe(ACCEPTED)
      const accepted = response.body as JobBody
      expect(queuedJob(accepted.id).locationsByConnection).toEqual({ [locatedId]: PLACES })

      await withScan(() =>
        runner.run(queuedJob(accepted.id), false, { scanWaitMs: 3000, scanPollMs: 25 })
      )

      const sent = located.callsTo('createShipment')
      expect(sent).toHaveLength(2)
      for (const call of sent) {
        expect(
          (call.args as { recipient: { locationIds?: unknown } }).recipient.locationIds
        ).toEqual(PLACES)
      }
      // The other carrier asked for none, so none were sent to it
      const asked = plainFake.state.calls
      expect(asked.length).toBeGreaterThan(0)
      expect(JSON.stringify(asked)).not.toContain('municipalityId')
      const job = (await asAdmin().get(ApiRoutes.shipments.bulkJob(accepted.id))).body as JobBody
      expect(job.succeeded).toBe(3)
    })

    it('refuses, with no run, places that are not in the list of their carrier', async () => {
      const order = await confirmed()
      const before = await runsOfStore()
      const response = await start([order.id], {
        locationsByConnection: { [locatedId]: { departmentId: '2', municipalityId: '11' } }
      })
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.SHIPPING_LOCATION_REQUIRED)
      expect(await runsOfStore()).toBe(before)
    })

    it("refuses the places of a carrier that asks for none, and of a connection that is not the store's", async () => {
      const order = await confirmed()
      const before = await runsOfStore()
      const notAsked = await start([order.id], { locationsByConnection: { [plainId]: PLACES } })
      expect(notAsked.status).toBe(CONFLICT)
      expect(codeOf(notAsked.body)).toBe(ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING)
      const stranger = await asAdminB()
        .post(ApiRoutes.shipments.bulk)
        .send({
          orderIds: [
            (await createOrder(owner, { storeId: ctx.storeB.id, status: 'CONFIRMED' })).id
          ],
          locationsByConnection: { [locatedId]: PLACES }
        })
      expect(stranger.status).toBe(NOT_FOUND)
      expect(await runsOfStore()).toBe(before)
    })

    it('does not take them together with a carrier the run is pinned to', async () => {
      const order = await confirmed()
      const response = await start([order.id], {
        connectionId: locatedId,
        locationIds: PLACES,
        locationsByConnection: { [locatedId]: PLACES }
      })
      expect(response.status).toBe(BAD_REQUEST)
    })
  })
})
