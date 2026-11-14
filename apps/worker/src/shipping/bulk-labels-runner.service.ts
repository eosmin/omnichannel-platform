import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  BulkLabelJobStatus,
  BulkOrderOutcomes,
  MembershipStatus,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentLimits,
  ShipmentPrintableStatuses,
  type ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes, errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import type { BulkLabelsMergeJob } from '@platform/core/queues'
import {
  type BulkResultEntry,
  entryOfOutcome,
  finalStatusOf,
  inSelectionOrder,
  labelIdsOf,
  MergedLabels,
  chunksOf,
  type OrderPart,
  partsOfOrder,
  PartsLedger,
  runLimited,
  type ShipmentOutcome,
  type ShipmentRequest,
  ShippingService,
  tallyOf
} from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'
import { ShipmentCreationModes } from '@platform/plugins/sdk'

// The guides an earlier attempt of the run made, from the account it left (their shipment ids): the next attempt finds them
// printable and must not take them for guides that already existed. A split order that lost a part keeps no such mark for the
// guides it did make (its entry is not a success), so a later attempt reports them as reused: accepted, nobody is called twice.
function createdBefore(results: unknown): Set<string> {
  const made = new Set<string>()
  if (!Array.isArray(results)) return made
  for (const entry of results as Partial<BulkResultEntry>[]) {
    if (entry.outcome !== BulkOrderOutcomes.CREATED || typeof entry.orderId !== 'string') continue
    // The account is read from the database: only a list of strings counts
    const ids = Array.isArray(entry.shipmentIds)
      ? entry.shipmentIds.filter((id): id is string => typeof id === 'string')
      : typeof entry.shipmentId === 'string'
        ? [entry.shipmentId]
        : []
    for (const id of ids) made.add(id)
  }
  return made
}

// The job as the run reads it
export interface RunningJob {
  id: string
  storeId: string
  orderIds: string[]
  requestedBy: string
}

export interface BulkRunOptions {
  // How long the run waits for the scan of a label a carrier made, and how often it asks (tests make them short)
  scanWaitMs?: number
  scanPollMs?: number
}

// The worker half of the bulk generation of labels (TDD_17 §4.6): makes the guides the orders are missing at the pace each carrier
// takes, reuses the label of an order that already has one, merges the stored files in the order the agent selected the orders
// into one PDF, and tells the person who asked how it went, order by order.
@Injectable()
export class BulkLabelsRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingService,
    private readonly merged: MergedLabels,
    private readonly registry: CarrierRegistry,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(BulkLabelsRunner.name)
  }

  private readonly plugins = (carrierId: string) => this.registry.find(carrierId)

  async run(
    data: BulkLabelsMergeJob,
    lastAttempt: boolean,
    options: BulkRunOptions = {}
  ): Promise<void> {
    const { storeId, jobId } = data
    const job = await this.prisma.client.bulkLabelJob.findFirst({
      where: { id: jobId, storeId },
      select: {
        id: true,
        storeId: true,
        status: true,
        orderIds: true,
        requestedBy: true,
        results: true
      }
    })
    if (job === null) {
      this.logger.warn({ jobId }, 'a bulk run of labels names a job the store does not have')
      return
    }
    // A run that already ended (a repeated job) is not run again
    const claimed = await this.prisma.client.bulkLabelJob.updateMany({
      where: {
        id: jobId,
        storeId,
        status: { in: [BulkLabelJobStatus.QUEUED, BulkLabelJobStatus.RUNNING] }
      },
      data: { status: BulkLabelJobStatus.RUNNING }
    })
    if (claimed.count === 0) return

    const settled = new Map<string, BulkResultEntry>()
    const ledger = new PartsLedger()
    const progress = new Progress(this.prisma, this.events, this.logger, job, settled)
    // The merged file, once it is stored: a fault after that must not hide it from the person who asked
    let storedMediaId: string | null = null
    try {
      // Who asked may have lost the permission since: the guides cost money, so it is checked when they would be made
      if (!(await this.mayStillPrint(storeId, job.requestedBy))) {
        for (const orderId of job.orderIds) {
          settled.set(orderId, {
            orderId,
            outcome: BulkOrderOutcomes.SKIPPED,
            errorCode: ErrorCodes.PERMISSION_DENIED
          })
        }
        await this.finish(job, settled, null)
        return
      }
      await this.createGuides(data, job, ledger, progress, createdBefore(job.results))
      // An order that did not end (a part whose outcome was lost) still keeps the guides its other parts made
      for (const entry of ledger.unfinished()) {
        if (!settled.has(entry.orderId)) progress.record(entry)
      }
      await progress.settle()
      const entries = inSelectionOrder(job.orderIds, settled)
      // Every label that exists goes in the file, in the order of the orders and, inside a split order, of its parts
      const shipmentIds = entries.flatMap(entry => labelIdsOf(entry))
      const outcome =
        shipmentIds.length === 0
          ? { file: null, leftOut: [] }
          : await this.merged.build(storeId, shipmentIds, {
              requestedBy: job.requestedBy,
              waitForScan: true,
              ...(options.scanWaitMs === undefined ? {} : { scanWaitMs: options.scanWaitMs }),
              ...(options.scanPollMs === undefined ? {} : { scanPollMs: options.scanPollMs })
            })
      storedMediaId = outcome.file?.mediaId ?? null
      // A guide that exists and is not in the file is reported against its order: it is not a success
      const reasonOf = new Map(outcome.leftOut.map(left => [left.shipmentId, left.reason]))
      for (const entry of entries) {
        const reason = labelIdsOf(entry)
          .map(id => reasonOf.get(id))
          .find(left => left !== undefined)
        if (reason !== undefined) {
          settled.set(entry.orderId, {
            ...entry,
            outcome: BulkOrderOutcomes.FAILED,
            reason
          })
        }
      }
      await this.finish(job, settled, outcome.file?.mediaId ?? null)
    } catch (error) {
      this.logger.error({ jobId, errorName: errorName(error) }, 'a bulk run of labels failed')
      // A guide a part of a split order made stays on the account even though its order did not end whole
      for (const entry of ledger.unfinished()) {
        if (!settled.has(entry.orderId)) settled.set(entry.orderId, entry)
      }
      // The next attempt finds what this one made (an order with its guide is reused); only the last one gives up
      if (lastAttempt) await this.fail(job, settled, storedMediaId)
      throw error
    }
  }

  // The guides the orders are missing. An order that is not the store's is skipped; one that already has a guide with a label to
  // print is reused (no carrier is called) and one whose guide cannot be printed yet is skipped; the rest are asked of the engine at
  // the pace of their carrier: a standalone or internal one at most `concurrency` at a time per connection, a pickup-bound one in
  // one call per connection (the engine splits it by the size of the batch the plugin takes and by pickup).
  private async createGuides(
    data: BulkLabelsMergeJob,
    job: { orderIds: string[]; requestedBy: string },
    ledger: PartsLedger,
    progress: Progress,
    createdBefore: ReadonlySet<string>
  ): Promise<void> {
    const { storeId } = data
    const orders = await this.prisma.client.order.findMany({
      where: { storeId, id: { in: job.orderIds } },
      select: { id: true }
    })
    const known = new Set(orders.map(order => order.id))
    const active = await this.prisma.client.shipment.findMany({
      where: {
        storeId,
        orderId: { in: job.orderIds },
        kind: ShipmentKind.OUTBOUND,
        status: { notIn: [...ShipmentInactiveStatuses] }
      },
      select: { id: true, orderId: true, status: true, originWarehouseId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const origins = await this.originsOf(storeId, [...known])
    const isPrintable = (status: string): boolean =>
      ShipmentPrintableStatuses.includes(status as ShipmentStatus)
    // An order is made of parts, one per warehouse it ships from (split fulfillment, TDD_16 §4.1) and one when it is not split. Each
    // part is judged on its own; the order says what became of all of them once the last one has (`ledger`).
    const requests: ShipmentRequest[] = []
    const slotOf = new Map<ShipmentRequest, number>()
    for (const orderId of new Set(job.orderIds)) {
      if (!known.has(orderId)) {
        progress.record({
          orderId,
          outcome: BulkOrderOutcomes.SKIPPED,
          errorCode: ErrorCodes.RESOURCE_NOT_FOUND
        })
        continue
      }
      const parts = partsOfOrder(
        origins.get(orderId) ?? [],
        active.filter(shipment => shipment.orderId === orderId),
        isPrintable
      )
      ledger.open(orderId, parts.length)
      const settle = (index: number, entry: BulkResultEntry): void => {
        const whole = ledger.fill(orderId, index, entry)
        if (whole !== null) progress.record(whole)
      }
      // The requests of one order are made one after another (see `lanes`): `slotOf` says which part each one is
      const mine: ShipmentRequest[] = []
      for (const [index, part] of parts.entries()) {
        const entry = this.entryOfExisting(orderId, part, createdBefore, isPrintable)
        if (entry !== null) {
          settle(index, entry)
          continue
        }
        const request: ShipmentRequest = {
          orderId,
          ...(data.connectionId === undefined ? {} : { connectionId: data.connectionId }),
          ...(data.locationIds === undefined ? {} : { locationIds: data.locationIds }),
          ...(data.pickup === undefined ? {} : { pickup: data.pickup }),
          // The warehouse the run judged is the one asked for: the engine refuses it if the order no longer ships from there
          ...(part.originWarehouseId === null ? {} : { originWarehouseId: part.originWarehouseId })
        }
        slotOf.set(request, index)
        mine.push(request)
      }
      requests.push(...mine)
    }
    if (requests.length === 0) return

    const caller = {
      actor: { type: 'user' as const, id: job.requestedBy },
      canOverridePrice: data.canOverridePrice
    }
    const routes = await this.shipping.routesOf(storeId, requests, this.plugins)
    // A run that follows each order's planned carrier gives the places by connection: a request gets the pair of the connection its
    // guide will be asked of, which is known only now, and no other request gets one
    if (data.locationsByConnection !== undefined) {
      for (const request of requests) {
        const route = routes.get(request.orderId)
        const places =
          route === undefined ? undefined : data.locationsByConnection[route.connectionId]
        if (request.locationIds === undefined && places !== undefined) request.locationIds = places
      }
    }
    const make = async (batch: ShipmentRequest[]): Promise<void> => {
      const outcomes: ShipmentOutcome[] = await this.shipping.createShipments(
        storeId,
        batch,
        caller,
        this.plugins
      )
      for (const [position, outcome] of outcomes.entries()) {
        const request = batch[position]
        const index = request === undefined ? undefined : slotOf.get(request)
        if (request === undefined || index === undefined) {
          // A guide the engine answered for and the run cannot place: it may exist at the carrier, so it is said
          this.logger.error(
            { position, batchSize: batch.length },
            'an outcome of a bulk run of labels names no part of an order'
          )
          continue
        }
        const whole = ledger.fill(request.orderId, index, entryOfOutcome(outcome))
        if (whole !== null) progress.record(whole)
      }
    }

    // The engine takes at most a hundred requests at once, and a split order sends more than one: a long list goes in runs, in order
    const makeAll = async (batch: ShipmentRequest[]): Promise<void> => {
      for (const run of chunksOf(batch, ShipmentLimits.MAX_REQUESTS)) await make(run)
    }

    // The connections are independent of each other: each one is its own lane, at its own pace
    const lanes = new Map<
      string,
      { concurrency: number; pickupBound: boolean; items: ShipmentRequest[][] }
    >()
    const unrouted: ShipmentRequest[] = []
    // The parts of one order go together: one after another in a standalone lane, so the amount to collect of each is read after
    // the guides of the parts before it, and in the same call (the engine writes them in this order) in a pickup-bound one
    const byOrder = new Map<string, ShipmentRequest[]>()
    for (const request of requests) {
      byOrder.set(request.orderId, [...(byOrder.get(request.orderId) ?? []), request])
    }
    for (const group of byOrder.values()) {
      const request = group[0]
      if (request === undefined) continue
      const route = routes.get(request.orderId)
      if (route === undefined) {
        unrouted.push(...group)
        continue
      }
      const lane = lanes.get(route.connectionId) ?? {
        concurrency: route.concurrency,
        pickupBound: route.mode === ShipmentCreationModes.PICKUP_BOUND,
        items: []
      }
      lane.items.push(group)
      lanes.set(route.connectionId, lane)
    }
    // Every lane is waited for even when one of them fails: a lane left running would go on making guides that cost money after
    // the run was closed or begun again, and its results would be lost. The first fault is thrown once all have stopped.
    const results = await Promise.allSettled([
      // No carrier to ask: the engine answers each of these with the refusal that says so
      unrouted.length === 0 ? Promise.resolve() : makeAll(unrouted),
      ...[...lanes.values()].map(lane =>
        lane.pickupBound
          ? makeAll(lane.items.flat())
          : runLimited(lane.items, lane.concurrency, async group => {
              for (const request of group) await make([request])
            }).then(() => undefined)
      )
    ])
    const failed = results.find(result => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  // What a part that already has a guide came to: one whose label can be printed is reused (or created, when an earlier attempt of
  // this run made it), one that cannot yet waits and is skipped. A part with no guide has no entry: it is asked of the engine.
  private entryOfExisting(
    orderId: string,
    part: OrderPart,
    createdBefore: ReadonlySet<string>,
    isPrintable: (status: string) => boolean
  ): BulkResultEntry | null {
    const { guide } = part
    if (guide === undefined) return null
    if (isPrintable(guide.status)) {
      return {
        orderId,
        outcome: createdBefore.has(guide.id) ? BulkOrderOutcomes.CREATED : BulkOrderOutcomes.REUSED,
        shipmentId: guide.id
      }
    }
    return {
      orderId,
      outcome: BulkOrderOutcomes.SKIPPED,
      errorCode: ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS,
      shipmentId: guide.id
    }
  }

  // The warehouses each order ships from, in the order their guides are made: the ones its lines are allocated to, by the priority
  // of the warehouse in the store (then by id, so the order never changes between runs). An order with no allocation has none.
  private async originsOf(
    storeId: string,
    orderIds: readonly string[]
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>()
    if (orderIds.length === 0) return result
    const rows = await this.prisma.client.orderItemAllocation.findMany({
      where: { storeId, orderItem: { orderId: { in: [...orderIds] } } },
      select: { warehouseId: true, orderItem: { select: { orderId: true } } }
    })
    const warehouseIds = [...new Set(rows.map(row => row.warehouseId))]
    const links =
      warehouseIds.length === 0
        ? []
        : await this.prisma.client.storeWarehouse.findMany({
            where: { storeId, warehouseId: { in: warehouseIds } },
            select: { warehouseId: true, priority: true }
          })
    const priority = new Map(links.map(link => [link.warehouseId, link.priority]))
    for (const row of rows) {
      const list = result.get(row.orderItem.orderId) ?? []
      if (!list.includes(row.warehouseId)) list.push(row.warehouseId)
      result.set(row.orderItem.orderId, list)
    }
    for (const list of result.values()) {
      list.sort(
        (a, b) =>
          (priority.get(a) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)
      )
    }
    return result
  }

  private async mayStillPrint(storeId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.client.membership.count({
      where: {
        userId,
        storeId,
        status: MembershipStatus.ACTIVE,
        revokedAt: null,
        role: { permissions: { some: { name: Permissions.SHIPPING_MANAGE } } }
      }
    })
    return member > 0
  }

  // The end of a run that went through: the account of every order, the file if there is one, and the word to the person
  private async finish(
    job: RunningJob,
    settled: ReadonlyMap<string, BulkResultEntry>,
    mergedMediaId: string | null
  ): Promise<void> {
    const entries = inSelectionOrder(job.orderIds, settled)
    const { succeeded, failed } = tallyOf(entries)
    await this.close(job, finalStatusOf(failed), entries, { succeeded, failed }, mergedMediaId)
  }

  // A run that stopped on a fault: what was done stays on the account, and the person is told it did not finish
  private async fail(
    job: RunningJob,
    settled: ReadonlyMap<string, BulkResultEntry>,
    mergedMediaId: string | null
  ): Promise<void> {
    const entries = [...settled.values()]
    await this.close(
      job,
      BulkLabelJobStatus.FAILED,
      entries,
      tallyOf(entries),
      mergedMediaId
    ).catch((error: unknown) => {
      this.logger.error(
        { jobId: job.id, errorName: errorName(error) },
        'a failed bulk run of labels could not be closed'
      )
    })
  }

  private async close(
    job: RunningJob,
    status: BulkLabelJobStatus,
    entries: readonly BulkResultEntry[],
    counts: { succeeded: number; failed: number },
    mergedMediaId: string | null
  ): Promise<void> {
    await this.prisma.transaction(async tx => {
      // Only a run that is still running ends: one that was already closed (by a repeated job) is not announced twice
      const closed = await tx.bulkLabelJob.updateMany({
        where: { id: job.id, storeId: job.storeId, status: BulkLabelJobStatus.RUNNING },
        data: {
          status,
          succeeded: counts.succeeded,
          failed: counts.failed,
          results: entries.map(entry => ({ ...entry })),
          mergedMediaId,
          finishedAt: new Date()
        }
      })
      if (closed.count === 0) return
      this.events.publish(tx, Events.BULK_LABELS_DONE, {
        storeId: job.storeId,
        jobId: job.id,
        requestedBy: job.requestedBy,
        status,
        mergedMediaId
      })
    })
  }
}

// The account of a run while it is under way: what has settled is written down and announced, one write at a time and always the
// latest account (the calls of several connections settle at the same time and must not overwrite each other with an older
// count). Orders that settle while a write is under way are written together by the next one, so a run of a hundred orders is a
// handful of writes and not a hundred.
class Progress {
  private running: Promise<void> | null = null
  private dirty = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger,
    private readonly job: RunningJob,
    private readonly settled: Map<string, BulkResultEntry>
  ) {}

  record(entry: BulkResultEntry): void {
    this.settled.set(entry.orderId, entry)
    this.dirty = true
    this.running ??= this.drain()
  }

  // Waits for every write that is due
  settle(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false
        await this.write()
      }
    } finally {
      this.running = null
    }
  }

  // A word of progress that cannot be written must not stop the guides that are being made: the end of the run says it all
  private async write(): Promise<void> {
    const entries = [...this.settled.values()]
    const { succeeded, failed } = tallyOf(entries)
    try {
      await this.prisma.transaction(async tx => {
        const written = await tx.bulkLabelJob.updateMany({
          where: {
            id: this.job.id,
            storeId: this.job.storeId,
            status: BulkLabelJobStatus.RUNNING
          },
          data: { succeeded, failed, results: entries.map(entry => ({ ...entry })) }
        })
        if (written.count === 0) return
        this.events.publish(tx, Events.BULK_LABELS_PROGRESS, {
          storeId: this.job.storeId,
          jobId: this.job.id,
          requestedBy: this.job.requestedBy,
          done: entries.length,
          total: this.job.orderIds.length,
          failed
        })
      })
    } catch (error) {
      this.logger.warn(
        { jobId: this.job.id, errorName: errorName(error) },
        'the progress of a bulk run of labels was not written'
      )
    }
  }
}
