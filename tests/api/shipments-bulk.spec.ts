import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { PinoLogger } from 'nestjs-pino'
import { PDFDocument } from 'pdf-lib'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  BulkLabelJobStatus,
  BulkLabelLeftOutReasons,
  BulkOrderOutcomes,
  CarrierId,
  MediaStatus,
  ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'
import { type BulkLabelsMergeJob, JobNames, QueueNames } from '@platform/core/queues'
import { MergedLabels, ShippingService } from '@platform/core/shipping'
import { StorageService } from '@platform/core/storage-module'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { NotificationsEventsListener } from '../../apps/api/src/modules/notifications/notifications-events.listener'
import { BulkLabelsCleaner } from '../../apps/worker/src/shipping/bulk-labels-cleaner.service'
import {
  BulkLabelsRunner,
  type BulkRunOptions
} from '../../apps/worker/src/shipping/bulk-labels-runner.service'
import {
  buildFakeCarrier,
  createCarrierConnection,
  createOrder,
  createShipment,
  type FakeCarrier,
  FakeCarrierBehaviors,
  labelHeightOf
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { type CapturedQueue, queueOf } from '../helpers/queue'

const OK = 200
const ACCEPTED = 202
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const DAY_MS = 24 * 60 * 60 * 1000

const quietLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as PinoLogger

interface JobBody {
  id: string
  status: string
  total: number
  succeeded: number
  failed: number
  results:
    | {
        orderId: string
        outcome: string
        shipmentId?: string
        shipmentIds?: string[]
        errorCode?: string
        reason?: string
      }[]
    | null
  download: { url: string; filename: string } | null
  finishedAt: string | null
}

interface MergeBody {
  download: { url: string; filename: string } | null
  merged: string[]
  leftOut: { shipmentId: string; reason: string }[]
  pageCount: number
  mixedSizes: boolean
}

const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }

describe('Bulk labels and "print labels" (TDD_17 §4.6)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let prisma: PrismaService
  let standalone: FakeCarrier
  let pickupBound: FakeCarrier
  let forzaId = ''
  let c807Id = ''
  let localId = ''
  let runner: BulkLabelsRunner
  let cleaner: BulkLabelsCleaner
  let storage: StorageService
  let heavy: CapturedQueue
  let events: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(CarrierRegistry, { strict: false })
    // Forza takes at most two guides at a time; C807 takes two shipments a call
    standalone = buildFakeCarrier({
      id: CarrierId.FORZA,
      cancel: true,
      fetchStatus: true,
      maxConcurrency: 2
    })
    pickupBound = buildFakeCarrier({
      id: CarrierId.C807,
      mode: 'pickup_bound',
      maxBatchSize: 2,
      fetchStatus: true
    })
    registry.register(standalone.plugin)
    registry.register(pickupBound.plugin)
    storage = app.get(StorageService, { strict: false })
    heavy = queueOf(app, QueueNames.HEAVY_PROCESSING)
    events = app.get(EventEmitter2, { strict: false })
    const domainEvents = app.get(DomainEvents, { strict: false })
    runner = new BulkLabelsRunner(
      prisma,
      app.get(ShippingService, { strict: false }),
      app.get(MergedLabels, { strict: false }),
      registry,
      domainEvents,
      quietLogger
    )
    cleaner = new BulkLabelsCleaner(prisma, storage, domainEvents, quietLogger)

    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    await owner.warehouse.update({
      where: { id: ctx.warehouseASecond.id },
      data: { address: { line1: 'Bodega 2', city: 'Santa Tecla', country: 'SV' } }
    })
    localId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'BA' })).id
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
      fake.state.inFlight = 0
      fake.state.peakInFlight = 0
      fake.state.gate = 0
      fake.state.gated = 0
    }
  })
  // The runs a test leaves unfinished count against the store: the cap of the runs under way is tested on its own
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
  const confirmed = (over: Partial<Parameters<typeof createOrder>[1]> = {}) =>
    createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id,
      carrierConnectionId: forzaId,
      ...over
    })
  // An order that names no carrier, and the store has no default one
  const unplanned = () =>
    createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id
    })
  const start = (orderIds: string[], body: Record<string, unknown> = {}) =>
    asAdmin()
      .post(ApiRoutes.shipments.bulk)
      .send({ orderIds, ...body })
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
  // The scan of a label a carrier made is the worker's: the suite stands in for it, a moment after each label arrives
  const withScan = async <T>(work: () => Promise<T>): Promise<T> => {
    let scanFault: unknown
    // One update after another, and the last one awaited before the test goes on: nothing lands after it
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
        .catch((error: unknown) => {
          scanFault = error
        })
    }, 25)
    try {
      const result = await work()
      clearInterval(timer)
      await pending
      // A stand-in that failed would look like a label that never got clean: say so
      expect(scanFault).toBeUndefined()
      return result
    } finally {
      clearInterval(timer)
      await pending
    }
  }
  const run = (jobId: string, options: BulkRunOptions = { scanWaitMs: 3000, scanPollMs: 25 }) =>
    runner.run(queuedJob(jobId), false, options)
  const read = async (jobId: string): Promise<JobBody> => {
    const response = await asAdmin().get(ApiRoutes.shipments.bulkJob(jobId))
    expect(response.status).toBe(OK)
    return response.body as JobBody
  }
  const shipmentOf = (orderId: string) =>
    owner.shipment.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } })
  // The heights of the pages of a stored file: the fake draws a label as tall as its guide number says
  const pagesOf = async (mediaId: string): Promise<number[]> => {
    const media = await owner.media.findUniqueOrThrow({ where: { id: mediaId } })
    const bytes = await storage.read(media.key, 5_000_000)
    const doc = await PDFDocument.load(bytes ?? new Uint8Array())
    return doc.getPages().map(page => Math.round(page.getHeight()))
  }
  const heightOfOrder = async (orderId: string): Promise<number> =>
    labelHeightOf((await shipmentOf(orderId)).guideNumber ?? '')
  const waitFor = async <T>(
    what: string,
    read: () => Promise<T | null | undefined>
  ): Promise<T> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const value = await read()
      if (value !== null && value !== undefined) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`gave up waiting for ${what}`)
  }

  describe('a bulk run over a mixed selection', () => {
    it('makes one PDF of the successes in the order selected and says what became of every order', async () => {
      const [first, second] = await Promise.all([confirmed(), confirmed()])
      const unconfirmed = await confirmed({ status: 'PENDING_CONFIRMATION' })
      const noCarrier = await unplanned()
      const alreadyLabeled = await confirmed()
      const stranger = await createOrder(owner, { storeId: ctx.storeB.id, status: 'CONFIRMED' })
      // The order that already has its guide: made earlier, through the same engine
      const earlier = await asAdmin()
        .post(ApiRoutes.shipments.forOrder(alreadyLabeled.id))
        .send({ connectionId: forzaId })
      expect(earlier.status).toBe(201)
      await owner.media.updateMany({
        where: { storeId: ctx.storeA.id, status: MediaStatus.PENDING },
        data: { status: MediaStatus.CLEAN }
      })
      standalone.state.calls.length = 0

      const selection = [
        second.id,
        unconfirmed.id,
        alreadyLabeled.id,
        noCarrier.id,
        stranger.id,
        first.id
      ]
      const seen: { done: number; total: number; failed: number }[] = []
      const listener = (payload: { jobId: string; done: number; total: number; failed: number }) =>
        seen.push({ done: payload.done, total: payload.total, failed: payload.failed })
      events.on(Events.BULK_LABELS_PROGRESS, listener)
      const done: { status: string; mergedMediaId: string | null }[] = []
      const finished = (payload: { status: string; mergedMediaId: string | null }) =>
        done.push({ status: payload.status, mergedMediaId: payload.mergedMediaId })
      events.on(Events.BULK_LABELS_DONE, finished)

      const response = await start(selection)
      expect(response.status).toBe(ACCEPTED)
      const accepted = response.body as JobBody
      expect(accepted).toMatchObject({
        status: BulkLabelJobStatus.QUEUED,
        total: 6,
        succeeded: 0,
        failed: 0,
        download: null
      })
      await withScan(() => run(accepted.id))
      events.off(Events.BULK_LABELS_PROGRESS, listener)
      events.off(Events.BULK_LABELS_DONE, finished)

      const job = await read(accepted.id)
      expect(job).toMatchObject({
        status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
        total: 6,
        succeeded: 3,
        failed: 3
      })
      expect(job.finishedAt).not.toBeNull()
      // One entry per order, in the order they were selected, each with what became of it
      expect(job.results?.map(entry => [entry.orderId, entry.outcome, entry.errorCode])).toEqual([
        [second.id, BulkOrderOutcomes.CREATED, undefined],
        [unconfirmed.id, BulkOrderOutcomes.SKIPPED, ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED],
        [alreadyLabeled.id, BulkOrderOutcomes.REUSED, undefined],
        [noCarrier.id, BulkOrderOutcomes.SKIPPED, ErrorCodes.SHIPPING_CARRIER_REQUIRED],
        [stranger.id, BulkOrderOutcomes.SKIPPED, ErrorCodes.RESOURCE_NOT_FOUND],
        [first.id, BulkOrderOutcomes.CREATED, undefined]
      ])

      // The carrier was asked for the two guides that were missing, and for nothing else
      expect(standalone.callsTo('createShipment')).toHaveLength(2)
      expect(standalone.state.calls).toHaveLength(2)

      // One file, with the pages of the successes in the order of the selection
      const download = job.download
      expect(download?.url).toContain('labels-')
      const mediaId = (await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: job.id } }))
        .mergedMediaId
      expect(mediaId).not.toBeNull()
      expect(await pagesOf(mediaId ?? '')).toEqual([
        await heightOfOrder(second.id),
        await heightOfOrder(alreadyLabeled.id),
        await heightOfOrder(first.id)
      ])
      const media = await owner.media.findUniqueOrThrow({ where: { id: mediaId ?? '' } })
      expect(media).toMatchObject({
        purpose: 'bulk_labels',
        status: MediaStatus.CLEAN,
        storeId: ctx.storeA.id,
        contentType: 'application/pdf'
      })

      // The requester heard the bar move up to the end, and that it is done
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.at(-1)).toEqual({ done: 6, total: 6, failed: 3 })
      expect(done).toEqual([
        { status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS, mergedMediaId: mediaId }
      ])
      // ... and was told by notification that the file is ready
      const notified = await waitFor('the notification that the labels are ready', async () => {
        const rows = await owner.notification.findMany({
          where: { userId: ctx.adminA.id, type: NotificationTypes.BULK_LABELS_READY }
        })
        return rows.length > 0 ? rows : null
      })
      expect(notified[0]).toMatchObject({ resourceType: 'bulk_label_job', resourceId: job.id })
      // The request is on the audit trail
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.BULK_LABELS_REQUESTED,
        resourceId: job.id
      })
      expect(entries).toHaveLength(1)
    })

    it('is complete, not "with errors", when every order made its label', async () => {
      const orders = await Promise.all([confirmed(), confirmed()])
      const accepted = (await start(orders.map(order => order.id))).body as JobBody
      await withScan(() => run(accepted.id))
      const job = await read(accepted.id)
      expect(job).toMatchObject({ status: BulkLabelJobStatus.COMPLETED, succeeded: 2, failed: 0 })
      expect(job.download).not.toBeNull()
    })

    it('makes no file when nothing qualified, and the run still ends by itself', async () => {
      const order = await confirmed({ status: 'PENDING_CONFIRMATION' })
      const accepted = (await start([order.id])).body as JobBody
      await run(accepted.id)
      const job = await read(accepted.id)
      expect(job).toMatchObject({
        status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
        succeeded: 0,
        failed: 1,
        download: null
      })
      expect(standalone.state.calls).toHaveLength(0)
      // Nothing to download: nobody is told a file is ready. The listener is asked directly, so that there is an answer to wait for
      await app.get(NotificationsEventsListener, { strict: false }).onBulkLabelsDone({
        storeId: ctx.storeA.id,
        jobId: job.id,
        requestedBy: ctx.adminA.id,
        status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
        mergedMediaId: null
      })
      const rows = await owner.notification.findMany({
        where: {
          type: NotificationTypes.BULK_LABELS_READY,
          resourceType: 'bulk_label_job',
          resourceId: job.id
        }
      })
      expect(rows).toHaveLength(0)
    })

    it('leaves out, and reports, a label that is still not clean when the wait is over', async () => {
      const order = await confirmed()
      const accepted = (await start([order.id])).body as JobBody
      // No scan stands in: the label of the carrier stays pending
      await run(accepted.id, { scanWaitMs: 150, scanPollMs: 25 })
      const job = await read(accepted.id)
      expect(job).toMatchObject({
        status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
        succeeded: 0,
        failed: 1,
        download: null
      })
      expect(job.results?.[0]).toMatchObject({
        outcome: BulkOrderOutcomes.FAILED,
        reason: BulkLabelLeftOutReasons.NOT_READY
      })
      // The guide exists and is not lost: the label can be printed once it is clean
      expect((await shipmentOf(order.id)).status).toBe(ShipmentStatus.LABEL_CREATED)
    })

    it('never asks a carrier twice for an order: a run repeated, or begun again after a crash, reuses what exists', async () => {
      const orders = await Promise.all([confirmed(), confirmed()])
      const accepted = (await start(orders.map(order => order.id))).body as JobBody
      await withScan(() => run(accepted.id))
      expect(standalone.callsTo('createShipment')).toHaveLength(2)

      // The same job again: it ended, so it is not run
      await run(accepted.id)
      expect(standalone.callsTo('createShipment')).toHaveLength(2)

      // A job that was left running by a worker that died: begun again, it finds the guides and makes none
      // The account the dead attempt left: it had made the guide of the first order
      const madeBefore = await shipmentOf(orders[0]?.id ?? '')
      const crashed = (
        await owner.bulkLabelJob.create({
          data: {
            storeId: ctx.storeA.id,
            status: BulkLabelJobStatus.RUNNING,
            orderIds: orders.map(order => order.id),
            total: 2,
            requestedBy: ctx.adminA.id,
            results: [
              {
                orderId: orders[0]?.id ?? '',
                outcome: BulkOrderOutcomes.CREATED,
                shipmentId: madeBefore.id
              }
            ]
          }
        })
      ).id
      await runner.run({ storeId: ctx.storeA.id, jobId: crashed, canOverridePrice: false }, true, {
        scanWaitMs: 500,
        scanPollMs: 25
      })
      const again = await read(crashed)
      expect(again).toMatchObject({ status: BulkLabelJobStatus.COMPLETED, succeeded: 2, failed: 0 })
      // The guide the earlier attempt paid for is still reported as made by the run; the other one already existed
      expect(again.results?.map(entry => entry.outcome)).toEqual([
        BulkOrderOutcomes.CREATED,
        BulkOrderOutcomes.REUSED
      ])
      expect(standalone.callsTo('createShipment')).toHaveLength(2)
    })

    it('does not run for a store that is not the one of the job', async () => {
      const order = await confirmed()
      const accepted = (await start([order.id])).body as JobBody
      await runner.run(
        { storeId: ctx.storeB.id, jobId: accepted.id, canOverridePrice: false },
        true
      )
      expect(standalone.state.calls).toHaveLength(0)
      expect((await read(accepted.id)).status).toBe(BulkLabelJobStatus.QUEUED)
    })

    it('makes no guide for a person who lost the permission between the request and the run', async () => {
      const printer = await actorWithPermissions(owner, app, {
        prefix,
        name: 'bulk-printer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW, Permissions.SHIPPING_MANAGE]
      })
      const order = await confirmed()
      const accepted = (
        await api(app, printer, ctx.storeA)
          .post(ApiRoutes.shipments.bulk)
          .send({ orderIds: [order.id] })
      ).body as JobBody
      await owner.membership.updateMany({
        where: { userId: printer.id, storeId: ctx.storeA.id },
        data: { revokedAt: new Date() }
      })
      await run(accepted.id)
      const job = (await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: accepted.id } }))
        .results
      expect(job).toEqual([
        {
          orderId: order.id,
          outcome: BulkOrderOutcomes.SKIPPED,
          errorCode: ErrorCodes.PERMISSION_DENIED
        }
      ])
      expect(standalone.state.calls).toHaveLength(0)
    })

    it('closes the run as failed on the last attempt that ends on a fault, with what was done', async () => {
      const order = await confirmed()
      const accepted = (await start([order.id])).body as JobBody
      const broken = new BulkLabelsRunner(
        prisma,
        app.get(ShippingService, { strict: false }),
        {
          build: () => Promise.reject(new Error('the storage is down'))
        } as unknown as MergedLabels,
        app.get(CarrierRegistry, { strict: false }),
        app.get(DomainEvents, { strict: false }),
        quietLogger
      )
      await expect(
        withScan(() =>
          broken.run(queuedJob(accepted.id), true, { scanWaitMs: 500, scanPollMs: 25 })
        )
      ).rejects.toThrow('the storage is down')
      const row = await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: accepted.id } })
      expect(row.status).toBe(BulkLabelJobStatus.FAILED)
      expect(row.finishedAt).not.toBeNull()
      // The guide that was made is on the account, not forgotten
      expect(row.results).toEqual([
        expect.objectContaining({ orderId: order.id, outcome: BulkOrderOutcomes.CREATED })
      ])
    })
  })

  describe('the pace each carrier takes', () => {
    it('asks a standalone carrier for no more guides at a time than it declared', async () => {
      const orders = await Promise.all(Array.from({ length: 6 }, () => confirmed()))
      const accepted = (await start(orders.map(order => order.id))).body as JobBody
      // The first two guides wait for each other: two are asked at once, and a third would make three
      standalone.state.gate = 2
      await withScan(() => run(accepted.id))
      expect(standalone.callsTo('createShipment')).toHaveLength(6)
      // It declared two: two at once, never three, and the pool does keep two going
      expect(standalone.state.peakInFlight).toBe(2)
      expect((await read(accepted.id)).succeeded).toBe(6)
    })

    it('makes one call per batch to a carrier whose guides exist inside a pickup, with the date and window asked', async () => {
      const orders = await Promise.all(
        Array.from({ length: 5 }, () => confirmed({ carrierConnectionId: c807Id }))
      )
      const refused = await owner.order.findUniqueOrThrow({
        where: { id: orders[3]?.id ?? '' },
        select: { orderNumber: true }
      })
      pickupBound.state.rejectReferences.add(refused.orderNumber)
      const window = { date: '2026-12-01', from: '09:00', to: '12:00' }
      const accepted = (
        await start(
          orders.map(order => order.id),
          { pickup: window }
        )
      ).body as JobBody
      await withScan(() => run(accepted.id))

      // Five orders, two a call: three calls and not five, none of them a single guide
      const calls = pickupBound.callsTo('createShipmentsWithPickup')
      expect(calls).toHaveLength(3)
      expect(pickupBound.callsTo('createShipment')).toHaveLength(0)
      for (const call of calls) {
        expect((call.args as { pickup: { window: unknown } }).pickup.window).toEqual(window)
      }
      const job = await read(accepted.id)
      expect(job).toMatchObject({
        status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
        succeeded: 4,
        failed: 1
      })
      expect(job.results?.[3]).toMatchObject({
        outcome: BulkOrderOutcomes.FAILED,
        errorCode: ErrorCodes.SHIPPING_CARRIER_REJECTED
      })
      expect(
        job.results?.filter(entry => entry.outcome === BulkOrderOutcomes.CREATED)
      ).toHaveLength(4)
      expect(job.download).not.toBeNull()
    })

    it('makes our own guides too, in the same run as a carrier that makes them', async () => {
      const mine = await confirmed({ carrierConnectionId: localId })
      const theirs = await confirmed()
      const accepted = (await start([theirs.id, mine.id])).body as JobBody
      await withScan(() => run(accepted.id))
      const job = await read(accepted.id)
      expect(job).toMatchObject({ status: BulkLabelJobStatus.COMPLETED, succeeded: 2 })
      expect((await shipmentOf(mine.id)).guideNumber).toMatch(/^BA-\d{6}$/)
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
    })

    it('takes the carrier named in the request for every order that names none', async () => {
      const order = await unplanned()
      const accepted = (await start([order.id], { connectionId: forzaId })).body as JobBody
      await withScan(() => run(accepted.id))
      expect((await read(accepted.id)).status).toBe(BulkLabelJobStatus.COMPLETED)
      expect((await shipmentOf(order.id)).connectionId).toBe(forzaId)
    })
  })

  describe('"print labels": the stored files of guides that exist', () => {
    const guides = async (count: number) => {
      const orders = await Promise.all(Array.from({ length: count }, () => confirmed()))
      for (const order of orders) {
        const made = await asAdmin()
          .post(ApiRoutes.shipments.forOrder(order.id))
          .send({ connectionId: forzaId })
        expect(made.status).toBe(201)
      }
      await owner.media.updateMany({
        where: { storeId: ctx.storeA.id, status: MediaStatus.PENDING },
        data: { status: MediaStatus.CLEAN }
      })
      standalone.state.calls.length = 0
      return Promise.all(orders.map(order => shipmentOf(order.id)))
    }
    const merge = (shipmentIds: string[]) =>
      asAdmin().post(ApiRoutes.shipments.mergeLabels).send({ shipmentIds })

    it('merges them in the order asked, with no call to the carrier', async () => {
      const [a, b, c] = await guides(3)
      const response = await merge([c?.id ?? '', a?.id ?? '', b?.id ?? ''])
      expect(response.status).toBe(OK)
      const body = response.body as MergeBody
      expect(body.merged).toEqual([c?.id, a?.id, b?.id])
      expect(body.leftOut).toEqual([])
      expect(body.pageCount).toBe(3)
      expect(body.mixedSizes).toBe(true)
      expect(body.download?.url).toContain('labels-')
      // The file is the pages in that order: the heights say it
      const file = await owner.media.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, purpose: 'bulk_labels' },
        orderBy: { createdAt: 'desc' }
      })
      expect(await pagesOf(file.id)).toEqual(
        [c, a, b].map(shipment => labelHeightOf(shipment?.guideNumber ?? ''))
      )
      // Reprinting calls the carrier zero times
      expect(standalone.state.calls).toHaveLength(0)
      // Who printed how many labels is on the audit trail
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.SHIPMENT_LABELS_MERGED
      })
      expect(entries.at(-1)?.metadata).toMatchObject({ asked: 3, merged: 3, leftOut: 0 })
    })

    it('never merges a label that was voided, and says so', async () => {
      const [a, b, c] = await guides(3)
      const cancelled = await asAdmin().post(ApiRoutes.shipments.cancel(b?.id ?? ''))
      expect(cancelled.status).toBe(OK)
      standalone.state.calls.length = 0
      const body = (await merge([a?.id ?? '', b?.id ?? '', c?.id ?? ''])).body as MergeBody
      expect(body.merged).toEqual([a?.id, c?.id])
      expect(body.leftOut).toEqual([
        { shipmentId: b?.id, reason: BulkLabelLeftOutReasons.NOT_PRINTABLE }
      ])
      expect(body.pageCount).toBe(2)
      expect(standalone.state.calls).toHaveLength(0)
    })

    it('makes no file of guides that cannot be printed, and still answers', async () => {
      const [a] = await guides(1)
      await asAdmin().post(ApiRoutes.shipments.cancel(a?.id ?? ''))
      const body = (await merge([a?.id ?? ''])).body as MergeBody
      expect(body).toMatchObject({ download: null, merged: [], pageCount: 0, mixedSizes: false })
      expect(body.leftOut).toHaveLength(1)
    })

    it("reports a guide that is not the store's as not found, like one that does not exist", async () => {
      const [a] = await guides(1)
      const foreign = await createShipment(owner, { storeId: ctx.storeB.id })
      const nobody = randomUUID()
      const body = (await merge([foreign.id, a?.id ?? '', nobody])).body as MergeBody
      expect(body.merged).toEqual([a?.id])
      expect(body.leftOut).toEqual([
        { shipmentId: foreign.id, reason: BulkLabelLeftOutReasons.NOT_FOUND },
        { shipmentId: nobody, reason: BulkLabelLeftOutReasons.NOT_FOUND }
      ])
    })

    it('leaves out a file that is not a PDF, whatever it says it is', async () => {
      const [a, b] = await guides(2)
      const row = await owner.shipment.findUniqueOrThrow({ where: { id: a?.id ?? '' } })
      const media = await owner.media.findUniqueOrThrow({ where: { id: row.labelMediaId ?? '' } })
      await storage.put(media.key, Buffer.from('%PDF-1.4 not really'), 'application/pdf')
      const body = (await merge([a?.id ?? '', b?.id ?? ''])).body as MergeBody
      expect(body.merged).toEqual([b?.id])
      expect(body.leftOut).toEqual([
        { shipmentId: a?.id, reason: BulkLabelLeftOutReasons.UNREADABLE }
      ])
    })
  })

  describe('an order split between two warehouses (TDD_16 §4.1, TDD_17 §4.6)', () => {
    // An order whose two lines leave from two warehouses of the store
    const splitOrder = async (over: Partial<Parameters<typeof createOrder>[1]> = {}) => {
      const order = await confirmed(over)
      const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
      const second = await owner.orderItem.create({
        data: {
          orderId: order.id,
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
      return order
    }
    const guidesOf = (orderId: string) =>
      owner.shipment.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
    // The guide the order has at a warehouse, made the way the agent makes one
    const guideAt = async (orderId: string, warehouseId: string, connectionId = forzaId) => {
      const made = await asAdmin()
        .post(ApiRoutes.shipments.forOrder(orderId))
        .send({ connectionId, originWarehouseId: warehouseId })
      expect(made.status).toBe(201)
      await owner.media.updateMany({
        where: { storeId: ctx.storeA.id, status: MediaStatus.PENDING },
        data: { status: MediaStatus.CLEAN }
      })
      return owner.shipment.findFirstOrThrow({
        where: { orderId, originWarehouseId: warehouseId },
        orderBy: { createdAt: 'desc' }
      })
    }
    const startAndRun = async (orderIds: string[]): Promise<JobBody> => {
      const accepted = (await start(orderIds)).body as JobBody
      await withScan(() => run(accepted.id))
      return read(accepted.id)
    }
    const fileOf = async (jobId: string): Promise<number[]> => {
      const row = await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: jobId } })
      return pagesOf(row.mergedMediaId ?? '')
    }

    it('makes one guide for each warehouse and puts every label of the order in the file', async () => {
      const order = await splitOrder()
      const job = await startAndRun([order.id])
      const guides = await guidesOf(order.id)
      expect(guides.map(guide => guide.originWarehouseId).sort()).toEqual(
        [ctx.warehouseA.id, ctx.warehouseASecond.id].sort()
      )
      expect(standalone.callsTo('createShipment')).toHaveLength(2)
      // One order, one success: the account counts orders, and names both guides in the order of the parts
      expect(job).toMatchObject({
        status: BulkLabelJobStatus.COMPLETED,
        total: 1,
        succeeded: 1,
        failed: 0
      })
      expect(job.results).toHaveLength(1)
      expect(job.results?.[0]).toMatchObject({
        orderId: order.id,
        outcome: BulkOrderOutcomes.CREATED
      })
      expect([...(job.results?.[0]?.shipmentIds ?? [])].sort()).toEqual(
        guides.map(guide => guide.id).sort()
      )
      expect(job.results?.[0]?.shipmentId).toBe(job.results?.[0]?.shipmentIds?.[0])
      expect(await fileOf(job.id)).toEqual(
        (job.results?.[0]?.shipmentIds ?? []).map(id =>
          labelHeightOf(guides.find(guide => guide.id === id)?.guideNumber ?? '')
        )
      )
    })

    it('splits the amount to collect between the guides so that they add up to the order', async () => {
      const order = await splitOrder({ paymentMethod: 'CASH_ON_DELIVERY' })
      await owner.order.update({
        where: { id: order.id },
        data: { subtotalCents: 2999, totalCents: 3199, shippingCents: 200 }
      })
      const job = await startAndRun([order.id])
      expect(job.status).toBe(BulkLabelJobStatus.COMPLETED)
      const guides = await guidesOf(order.id)
      expect(guides).toHaveLength(2)
      expect(guides.reduce((sum, guide) => sum + (guide.codAmountCents ?? 0), 0)).toBe(3199)
    })

    it('makes only the guide the order is missing and reuses the one it has, with no call for it', async () => {
      const order = await splitOrder()
      const first = await guideAt(order.id, ctx.warehouseA.id)
      standalone.state.calls.length = 0
      const job = await startAndRun([order.id])
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
      const guides = await guidesOf(order.id)
      expect(guides).toHaveLength(2)
      expect(job.results?.[0]).toMatchObject({ outcome: BulkOrderOutcomes.CREATED })
      expect(job.results?.[0]?.shipmentIds).toContain(first.id)
      expect(job.results?.[0]?.shipmentIds).toHaveLength(2)
      expect(await fileOf(job.id)).toHaveLength(2)
    })

    it('calls nobody for an order whose guides all exist: it is reused and every label is printed', async () => {
      const order = await splitOrder()
      const a = await guideAt(order.id, ctx.warehouseA.id)
      const b = await guideAt(order.id, ctx.warehouseASecond.id)
      standalone.state.calls.length = 0
      const job = await startAndRun([order.id])
      expect(standalone.state.calls).toHaveLength(0)
      expect(job.results?.[0]).toMatchObject({ outcome: BulkOrderOutcomes.REUSED })
      expect([...(job.results?.[0]?.shipmentIds ?? [])].sort()).toEqual([a.id, b.id].sort())
      expect(await fileOf(job.id)).toHaveLength(2)
    })

    it('fails the order when one part cannot be printed yet, and still prints the label of the other', async () => {
      const order = await splitOrder()
      const a = await guideAt(order.id, ctx.warehouseA.id)
      const b = await guideAt(order.id, ctx.warehouseASecond.id)
      await owner.shipment.update({
        where: { id: b.id },
        data: { status: ShipmentStatus.CANCEL_PENDING }
      })
      standalone.state.calls.length = 0
      const job = await startAndRun([order.id])
      expect(standalone.state.calls).toHaveLength(0)
      expect(job).toMatchObject({
        status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
        succeeded: 0,
        failed: 1
      })
      expect(job.results?.[0]).toMatchObject({
        outcome: BulkOrderOutcomes.SKIPPED,
        errorCode: ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS,
        shipmentId: b.id,
        shipmentIds: [a.id]
      })
      expect(await fileOf(job.id)).toEqual([labelHeightOf(a.guideNumber ?? '')])
    })

    it('never prints the label of a guide that was voided, and makes the part a new one', async () => {
      const order = await splitOrder()
      await guideAt(order.id, ctx.warehouseA.id)
      const voided = await guideAt(order.id, ctx.warehouseASecond.id)
      await owner.shipment.update({
        where: { id: voided.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      standalone.state.calls.length = 0
      const job = await startAndRun([order.id])
      expect(standalone.callsTo('createShipment')).toHaveLength(1)
      expect(job.results?.[0]?.shipmentIds).not.toContain(voided.id)
      expect(job.results?.[0]?.shipmentIds).toHaveLength(2)
      expect(await fileOf(job.id)).toHaveLength(2)
    })

    it('keeps the labels of a split order together and in the order of the selection', async () => {
      const [before, order, after] = await Promise.all([confirmed(), splitOrder(), confirmed()])
      const job = await startAndRun([before.id, order.id, after.id])
      expect(job).toMatchObject({ status: BulkLabelJobStatus.COMPLETED, total: 3, succeeded: 3 })
      const guides = await guidesOf(order.id)
      const heights = [
        await heightOfOrder(before.id),
        ...(job.results?.[1]?.shipmentIds ?? []).map(id =>
          labelHeightOf(guides.find(guide => guide.id === id)?.guideNumber ?? '')
        ),
        await heightOfOrder(after.id)
      ]
      expect(await fileOf(job.id)).toEqual(heights)
    })

    it('asks a carrier whose guides exist inside a pickup for both guides of the order in one call', async () => {
      const order = await splitOrder({ carrierConnectionId: c807Id })
      const job = await startAndRun([order.id])
      expect(pickupBound.callsTo('createShipmentsWithPickup')).toHaveLength(1)
      expect(job).toMatchObject({ status: BulkLabelJobStatus.COMPLETED, succeeded: 1 })
      expect(job.results?.[0]?.shipmentIds).toHaveLength(2)
      expect(await guidesOf(order.id)).toHaveLength(2)
    })

    it('makes no second guide for an order whose lines moved to another warehouse after its guide was made', async () => {
      const order = await confirmed()
      const made = await asAdmin()
        .post(ApiRoutes.shipments.forOrder(order.id))
        .send({ connectionId: forzaId })
      expect(made.status).toBe(201)
      await owner.media.updateMany({
        where: { storeId: ctx.storeA.id, status: MediaStatus.PENDING },
        data: { status: MediaStatus.CLEAN }
      })
      // The lines moved to the other warehouse after the guide was made (the database never lets a guide change its origin)
      await owner.orderItemAllocation.updateMany({
        where: { orderItem: { orderId: order.id } },
        data: { warehouseId: ctx.warehouseASecond.id }
      })
      standalone.state.calls.length = 0
      const job = await startAndRun([order.id])
      expect(standalone.state.calls).toHaveLength(0)
      expect(await guidesOf(order.id)).toHaveLength(1)
      expect(job.results?.[0]).toMatchObject({ outcome: BulkOrderOutcomes.REUSED })
      expect(job.succeeded).toBe(1)
    })

    it('fails the order when the carrier refuses one part, and prints the label of the part that was made', async () => {
      const order = await splitOrder()
      // The carrier takes the first guide and refuses the second: the references are the order number for both, so refuse by call
      const original = standalone.plugin.createShipment?.bind(standalone.plugin)
      let calls = 0
      Object.assign(standalone.plugin, {
        createShipment: (...args: Parameters<NonNullable<typeof original>>) => {
          calls += 1
          if (calls === 2) return Promise.reject(new Error('refused'))
          return (original as NonNullable<typeof original>)(...args)
        }
      })
      try {
        const job = await startAndRun([order.id])
        expect(job).toMatchObject({
          status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
          succeeded: 0,
          failed: 1
        })
        expect(job.results?.[0]?.outcome).toBe(BulkOrderOutcomes.FAILED)
        expect(job.results?.[0]?.shipmentIds).toHaveLength(1)
        expect(job.results?.[0]?.errorCode).toBeDefined()
        expect(await fileOf(job.id)).toHaveLength(1)
      } finally {
        Object.assign(standalone.plugin, { createShipment: original })
      }
    })

    it('makes the guides in the order of the priority of the warehouses in the store', async () => {
      // One row after the other, each to a value nobody holds (the priority of a store is unique)
      const prioritise = async (priorities: { warehouseId: string; priority: number }[]) => {
        for (const entry of priorities) {
          await owner.storeWarehouse.updateMany({
            where: { storeId: ctx.storeA.id, warehouseId: entry.warehouseId },
            data: { priority: entry.priority }
          })
        }
      }
      const before = await owner.storeWarehouse.findMany({
        where: {
          storeId: ctx.storeA.id,
          warehouseId: { in: [ctx.warehouseA.id, ctx.warehouseASecond.id] }
        },
        select: { warehouseId: true, priority: true }
      })
      try {
        await prioritise([
          { warehouseId: ctx.warehouseASecond.id, priority: 2000 },
          { warehouseId: ctx.warehouseA.id, priority: 2001 }
        ])
        const order = await splitOrder()
        const job = await startAndRun([order.id])
        const guides = await guidesOf(order.id)
        expect(guides.map(guide => guide.originWarehouseId)).toEqual([
          ctx.warehouseASecond.id,
          ctx.warehouseA.id
        ])
        expect(job.results?.[0]?.shipmentIds).toEqual(guides.map(guide => guide.id))
      } finally {
        await prioritise(before)
      }
    })

    it('prints every label of a split order with "print labels"', async () => {
      const order = await splitOrder()
      const a = await guideAt(order.id, ctx.warehouseA.id)
      const b = await guideAt(order.id, ctx.warehouseASecond.id)
      standalone.state.calls.length = 0
      const response = await asAdmin()
        .post(ApiRoutes.shipments.mergeLabels)
        .send({ shipmentIds: [b.id, a.id] })
      expect(response.status).toBe(OK)
      expect((response.body as MergeBody).merged).toEqual([b.id, a.id])
      expect(standalone.state.calls).toHaveLength(0)
    })
  })

  describe('what the cleanup removes', () => {
    it('deletes a merged file past the days of its store, and nothing that is still kept', async () => {
      const orders = await Promise.all([confirmed(), confirmed()])
      const accepted = (await start(orders.map(order => order.id))).body as JobBody
      await withScan(() => run(accepted.id))
      const job = await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: accepted.id } })
      const stale = job.mergedMediaId ?? ''
      const fresh = (
        await asAdmin()
          .post(ApiRoutes.shipments.mergeLabels)
          .send({ shipmentIds: [(await shipmentOf(orders[0]?.id ?? '')).id] })
      ).body as MergeBody
      expect(fresh.download).not.toBeNull()
      const keptRow = await owner.media.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, purpose: 'bulk_labels', id: { not: stale } },
        orderBy: { createdAt: 'desc' }
      })
      const staleRow = await owner.media.findUniqueOrThrow({ where: { id: stale } })
      // Seven days is what the store keeps them (the default of its settings)
      await owner.media.update({
        where: { id: stale },
        data: { createdAt: new Date(Date.now() - 8 * DAY_MS) }
      })

      const report = await cleaner.run()
      expect(report.filesDeleted).toBeGreaterThanOrEqual(1)
      expect(await owner.media.findUnique({ where: { id: stale } })).toBeNull()
      expect(await storage.read(staleRow.key, 1_000_000)).toBeNull()
      expect(await owner.media.findUnique({ where: { id: keptRow.id } })).not.toBeNull()
      expect(await storage.read(keptRow.key, 1_000_000)).not.toBeNull()
      // The run that made it points at nothing now, and its screen says the file is gone
      expect(
        (await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: accepted.id } })).mergedMediaId
      ).toBeNull()
      expect((await read(accepted.id)).download).toBeNull()
    })

    it('keeps a file longer for a store that asked for more days', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { bulkLabelRetentionDays: 30 }
      })
      try {
        const order = await confirmed({ carrierConnectionId: localId })
        await asAdmin().post(ApiRoutes.shipments.forOrder(order.id)).send({ connectionId: localId })
        const shipment = await shipmentOf(order.id)
        await asAdmin()
          .post(ApiRoutes.shipments.mergeLabels)
          .send({ shipmentIds: [shipment.id] })
        const file = await owner.media.findFirstOrThrow({
          where: { storeId: ctx.storeA.id, purpose: 'bulk_labels' },
          orderBy: { createdAt: 'desc' }
        })
        await owner.media.update({
          where: { id: file.id },
          data: { createdAt: new Date(Date.now() - 20 * DAY_MS) }
        })
        await cleaner.run()
        expect(await owner.media.findUnique({ where: { id: file.id } })).not.toBeNull()
        await owner.media.update({
          where: { id: file.id },
          data: { createdAt: new Date(Date.now() - 31 * DAY_MS) }
        })
        await cleaner.run()
        expect(await owner.media.findUnique({ where: { id: file.id } })).toBeNull()
      } finally {
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { bulkLabelRetentionDays: 7 }
        })
      }
    })

    it('keeps a file at least a day whatever the days of the store say, so it is never taken from the run that just made it', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { bulkLabelRetentionDays: 0 }
      })
      try {
        const order = await confirmed({ carrierConnectionId: localId })
        await asAdmin().post(ApiRoutes.shipments.forOrder(order.id)).send({ connectionId: localId })
        const guide = await shipmentOf(order.id)
        const made = (
          await asAdmin()
            .post(ApiRoutes.shipments.mergeLabels)
            .send({ shipmentIds: [guide.id] })
        ).body as MergeBody
        expect(made.download).not.toBeNull()
        const file = await owner.media.findFirstOrThrow({
          where: { storeId: ctx.storeA.id, purpose: 'bulk_labels' },
          orderBy: { createdAt: 'desc' }
        })
        await cleaner.run()
        expect(await owner.media.findUnique({ where: { id: file.id } })).not.toBeNull()
        await owner.media.update({
          where: { id: file.id },
          data: { createdAt: new Date(Date.now() - 2 * DAY_MS) }
        })
        await cleaner.run()
        expect(await owner.media.findUnique({ where: { id: file.id } })).toBeNull()
      } finally {
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { bulkLabelRetentionDays: 7 }
        })
      }
    })

    it('closes a run that was lost, so that nobody waits for it, and tells its requester', async () => {
      const lost = await owner.bulkLabelJob.create({
        data: {
          storeId: ctx.storeA.id,
          status: BulkLabelJobStatus.RUNNING,
          orderIds: [randomUUID()],
          total: 1,
          requestedBy: ctx.adminA.id,
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000)
        }
      })
      const recent = await owner.bulkLabelJob.create({
        data: {
          storeId: ctx.storeA.id,
          status: BulkLabelJobStatus.QUEUED,
          orderIds: [randomUUID()],
          total: 1,
          requestedBy: ctx.adminA.id
        }
      })
      const done: string[] = []
      const listener = (payload: { jobId: string; status: string }) =>
        done.push(`${payload.jobId}:${payload.status}`)
      events.on(Events.BULK_LABELS_DONE, listener)
      const report = await cleaner.run()
      events.off(Events.BULK_LABELS_DONE, listener)
      expect(report.jobsClosed).toBeGreaterThanOrEqual(1)
      const closed = await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: lost.id } })
      expect(closed.status).toBe(BulkLabelJobStatus.FAILED)
      expect(closed.finishedAt).not.toBeNull()
      expect(done).toContain(`${lost.id}:${BulkLabelJobStatus.FAILED}`)
      expect(
        (await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: recent.id } })).status
      ).toBe(BulkLabelJobStatus.QUEUED)
    })
  })

  describe('who may do what, and in whose store', () => {
    it('lets a viewer do none of it', async () => {
      const order = await confirmed()
      const job = (await start([order.id])).body as JobBody
      const viewer = () => api(app, ctx.viewerA, ctx.storeA)
      const answers = await Promise.all([
        viewer()
          .post(ApiRoutes.shipments.bulk)
          .send({ orderIds: [order.id] }),
        viewer().get(ApiRoutes.shipments.bulkJob(job.id)),
        viewer()
          .post(ApiRoutes.shipments.mergeLabels)
          .send({ shipmentIds: [randomUUID()] })
      ])
      for (const answer of answers) expect(answer.status).toBe(FORBIDDEN)
    })

    it('does not show a run to another store, nor start one with its carrier or its orders', async () => {
      const order = await confirmed()
      const job = (await start([order.id])).body as JobBody
      const asB = () => api(app, ctx.adminB, ctx.storeB)
      expect((await asB().get(ApiRoutes.shipments.bulkJob(job.id))).status).toBe(NOT_FOUND)
      // The carrier of store A is a 404 for store B, not a skip of every order later
      const foreign = await asB()
        .post(ApiRoutes.shipments.bulk)
        .send({ orderIds: [order.id], connectionId: forzaId })
      expect(foreign.status).toBe(NOT_FOUND)
      // The order of store A is "not found" in the run of store B, and no guide is made for it
      const own = (
        await asB()
          .post(ApiRoutes.shipments.bulk)
          .send({ orderIds: [order.id] })
      ).body as JobBody
      await run(own.id)
      expect(
        (await owner.bulkLabelJob.findUniqueOrThrow({ where: { id: own.id } })).results
      ).toEqual([
        {
          orderId: order.id,
          outcome: BulkOrderOutcomes.SKIPPED,
          errorCode: ErrorCodes.RESOURCE_NOT_FOUND
        }
      ])
      expect(await owner.shipment.count({ where: { orderId: order.id } })).toBe(0)
    })

    it('refuses a body that names the store, no order, too many, a repeated one or a thing it does not know', async () => {
      const order = await confirmed()
      const bad: Record<string, unknown>[] = [
        { orderIds: [order.id], storeId: ctx.storeB.id },
        { orderIds: [] },
        { orderIds: Array.from({ length: 101 }, () => randomUUID()) },
        { orderIds: [order.id, order.id] },
        { orderIds: ['not-an-id'] },
        { orderIds: [order.id], pickup: { date: '2026-02-31', from: '09:00', to: '12:00' } },
        { orderIds: [order.id], status: 'completed' }
      ]
      for (const body of bad) {
        const response = await asAdmin().post(ApiRoutes.shipments.bulk).send(body)
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect(
        (await asAdmin().post(ApiRoutes.shipments.mergeLabels).send({ shipmentIds: [] })).status
      ).toBe(BAD_REQUEST)
      expect(
        (
          await asAdmin()
            .post(ApiRoutes.shipments.mergeLabels)
            .send({ shipmentIds: [randomUUID(), 'x'] })
        ).status
      ).toBe(BAD_REQUEST)
      expect((await asAdmin().get(ApiRoutes.shipments.bulkJob('nope'))).status).toBe(BAD_REQUEST)
    })

    it('shows a run, and its file, to the person who asked for it and to nobody else of the store', async () => {
      const order = await confirmed()
      const job = (await start([order.id])).body as JobBody
      await withScan(() => run(job.id))
      const colleague = await actorWithPermissions(owner, app, {
        prefix,
        name: 'bulk-colleague',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.SHIPPING_VIEW, Permissions.SHIPPING_MANAGE]
      })
      const asColleague = () => api(app, colleague, ctx.storeA)
      expect((await asColleague().get(ApiRoutes.shipments.bulkJob(job.id))).status).toBe(NOT_FOUND)
      expect((await read(job.id)).download).not.toBeNull()
      // The label of a guide is read through the media route only by who prints guides
      const label = await owner.media.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, purpose: 'shipping_label', orderId: order.id }
      })
      const reader = await actorWithPermissions(owner, app, {
        prefix,
        name: 'bulk-media-reader',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.MEDIA_VIEW]
      })
      const asReader = api(app, reader, ctx.storeA)
      expect((await asReader.get(ApiRoutes.media.byId(label.id))).status).toBe(FORBIDDEN)
    })

    it('refuses a run while the store has as many under way as it may', async () => {
      const order = await confirmed()
      const active = Array.from({ length: 5 }, () => ({
        storeId: ctx.storeA.id,
        orderIds: [randomUUID()],
        total: 1,
        requestedBy: ctx.adminA.id
      }))
      await owner.bulkLabelJob.createMany({ data: active })
      const refused = await start([order.id])
      expect(refused.status).toBe(429)
      expect(
        (refused.body as { error: { metadata?: { retryAfterSeconds?: number } } }).error.metadata
          ?.retryAfterSeconds
      ).toBeGreaterThan(0)
      // The other store is not held back by it
      const other = await createOrder(owner, { storeId: ctx.storeB.id, status: 'CONFIRMED' })
      expect(
        (
          await api(app, ctx.adminB, ctx.storeB)
            .post(ApiRoutes.shipments.bulk)
            .send({ orderIds: [other.id] })
        ).status
      ).toBe(ACCEPTED)
    })

    it('accepts the largest run, a hundred orders', async () => {
      const ids = Array.from({ length: 100 }, () => randomUUID())
      const response = await start(ids)
      expect(response.status).toBe(ACCEPTED)
      expect((response.body as JobBody).total).toBe(100)
    })
  })
})
