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
  hasLabel,
  inSelectionOrder,
  MergedLabels,
  runLimited,
  type ShipmentOutcome,
  type ShipmentRequest,
  ShippingService,
  tallyOf
} from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'
import { ShipmentCreationModes } from '@platform/plugins/sdk'

// The guides an earlier attempt of the run made, from the account it left (order id to shipment id): the next attempt finds them
// printable and must not take them for guides that already existed
function createdBefore(results: unknown): Map<string, string> {
  const made = new Map<string, string>()
  if (!Array.isArray(results)) return made
  for (const entry of results as Partial<BulkResultEntry>[]) {
    if (
      entry.outcome === BulkOrderOutcomes.CREATED &&
      typeof entry.orderId === 'string' &&
      typeof entry.shipmentId === 'string'
    ) {
      made.set(entry.orderId, entry.shipmentId)
    }
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
      await this.createGuides(data, job, settled, progress, createdBefore(job.results))
      await progress.settle()
      const entries = inSelectionOrder(job.orderIds, settled)
      const withLabel = entries.filter(hasLabel)
      const shipmentIds = withLabel.flatMap(entry =>
        entry.shipmentId === undefined ? [] : [entry.shipmentId]
      )
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
      for (const entry of withLabel) {
        const reason = entry.shipmentId === undefined ? undefined : reasonOf.get(entry.shipmentId)
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
    settled: Map<string, BulkResultEntry>,
    progress: Progress,
    createdBefore: ReadonlyMap<string, string>
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
      select: { id: true, orderId: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const requests: ShipmentRequest[] = []
    for (const orderId of job.orderIds) {
      if (!known.has(orderId)) {
        progress.record({
          orderId,
          outcome: BulkOrderOutcomes.SKIPPED,
          errorCode: ErrorCodes.RESOURCE_NOT_FOUND
        })
        continue
      }
      const mine = active.filter(shipment => shipment.orderId === orderId)
      // The newest one that can be printed; an order with only guides that cannot be printed yet waits for them
      const printable = mine.find(shipment =>
        ShipmentPrintableStatuses.includes(shipment.status as ShipmentStatus)
      )
      if (printable !== undefined) {
        // A guide an earlier attempt of this run made (the account kept it) is still the one this run paid for
        progress.record({
          orderId,
          outcome:
            createdBefore.get(orderId) === printable.id
              ? BulkOrderOutcomes.CREATED
              : BulkOrderOutcomes.REUSED,
          shipmentId: printable.id
        })
      } else if (mine.length > 0) {
        progress.record({
          orderId,
          outcome: BulkOrderOutcomes.SKIPPED,
          errorCode: ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS,
          ...(mine[0] === undefined ? {} : { shipmentId: mine[0].id })
        })
      } else {
        requests.push({
          orderId,
          ...(data.connectionId === undefined ? {} : { connectionId: data.connectionId }),
          ...(data.pickup === undefined ? {} : { pickup: data.pickup })
        })
      }
    }
    if (requests.length === 0) return

    const caller = {
      actor: { type: 'user' as const, id: job.requestedBy },
      canOverridePrice: data.canOverridePrice
    }
    const routes = await this.shipping.routesOf(storeId, requests, this.plugins)
    const make = async (batch: ShipmentRequest[]): Promise<void> => {
      const outcomes: ShipmentOutcome[] = await this.shipping.createShipments(
        storeId,
        batch,
        caller,
        this.plugins
      )
      for (const outcome of outcomes) progress.record(entryOfOutcome(outcome))
    }

    // The connections are independent of each other: each one is its own lane, at its own pace
    const lanes = new Map<
      string,
      { concurrency: number; pickupBound: boolean; items: ShipmentRequest[] }
    >()
    const unrouted: ShipmentRequest[] = []
    for (const request of requests) {
      const route = routes.get(request.orderId)
      if (route === undefined) {
        unrouted.push(request)
        continue
      }
      const lane = lanes.get(route.connectionId) ?? {
        concurrency: route.concurrency,
        pickupBound: route.mode === ShipmentCreationModes.PICKUP_BOUND,
        items: []
      }
      lane.items.push(request)
      lanes.set(route.connectionId, lane)
    }
    // Every lane is waited for even when one of them fails: a lane left running would go on making guides that cost money after
    // the run was closed or begun again, and its results would be lost. The first fault is thrown once all have stopped.
    const results = await Promise.allSettled([
      // No carrier to ask: the engine answers each of these with the refusal that says so
      unrouted.length === 0 ? Promise.resolve() : make(unrouted),
      ...[...lanes.values()].map(lane =>
        lane.pickupBound
          ? make(lane.items)
          : runLimited(lane.items, lane.concurrency, request => make([request])).then(
              () => undefined
            )
      )
    ])
    const failed = results.find(result => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
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
