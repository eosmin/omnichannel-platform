import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { CacheKeys } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import {
  CarrierConnectionStatus,
  OrderStatus,
  PickupSchedule,
  pickupSyncJobOptions,
  PickupStatus,
  ShipmentInactiveStatuses,
  ShipmentKind
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  type EvaluatePickupsJob,
  JobNames,
  QueueNames,
  type SyncPickupJob,
  syncPickupJobId,
  syncPickupSweepJobId
} from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  cutoffReminderDue,
  isAutoPickupDue,
  PickupEligibleStatuses,
  PickupsService,
  type PickupScheduleRules,
  ShippingService,
  storeClockOf
} from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'
import { ShipmentCreationModes } from '@platform/plugins/sdk'

// A tick that starts later than this after its minute is not run: what it would decide is about a moment that is over
const STALE_TICK_MS = 10 * 60 * 1000
const MINUTE_MS = 60_000
// The guides one `autoPickup` run asks for (one call of the engine)
const AUTO_RUN_ORDERS = 100
// ... and the most pages of them in one run
const AUTO_RUN_MAX_PAGES = 20

export interface PickupEvaluation {
  connections: number
  pickupsMade: number
  guidesMade: number
  reminders: number
  swept: number
  failed: number
}

// The pickups of every connection, looked at once a minute by ONE job (TDD_17 §4.10: schedules cannot be made per tenant row). For
// each connection that takes pickups, with the clock of its store: a standalone carrier gets its pickup at `autoPickupTime` through
// `ensurePickup` (the same call a person's request makes, so the two end in one pickup); a pickup-bound carrier gets its guides and
// its pickup together; and the cutoff reminder is raised once per day when guides still wait. Then a sweep asks the carrier again
// for what no job will: a pickup nobody queued, a count the carrier has not acknowledged.
@Injectable()
export class PickupEvaluator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CarrierRegistry,
    private readonly pickups: PickupsService,
    private readonly shipping: ShippingService,
    private readonly events: DomainEvents,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<SyncPickupJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PickupEvaluator.name)
  }

  run(job: EvaluatePickupsJob, nowMs = Date.now()): Promise<PickupEvaluation | null> {
    const at = new Date(job.minute * MINUTE_MS)
    if (nowMs - at.getTime() > STALE_TICK_MS) {
      this.logger.warn(
        { minute: job.minute },
        'a pickup evaluation started too late and was dropped'
      )
      return Promise.resolve(null)
    }
    return this.claimMinute(job.minute).then(first => (first ? this.evaluate(at) : null))
  }

  // One evaluation per minute, whatever the retention of the queue and however many replicas tick: the job id does the same, but
  // a finished job record can be trimmed by a burst of other heavy jobs
  private async claimMinute(minute: number): Promise<boolean> {
    const first = await this.redis.set(
      CacheKeys.pickup.evaluation(minute),
      '1',
      'EX',
      PickupSchedule.EVALUATION_MEMORY_SECONDS,
      'NX'
    )
    return first === 'OK'
  }

  async evaluate(now: Date): Promise<PickupEvaluation> {
    const report: PickupEvaluation = {
      connections: 0,
      pickupsMade: 0,
      guidesMade: 0,
      reminders: 0,
      swept: 0,
      failed: 0
    }
    const connections = await this.prisma.client.carrierConnection.findMany({
      where: { status: CarrierConnectionStatus.ACTIVE, pickupEnabled: true },
      select: {
        id: true,
        storeId: true,
        carrierId: true,
        pickupDays: true,
        pickupCutoffTime: true,
        autoPickup: true,
        autoPickupTime: true,
        pickupReminderMinutes: true,
        store: { select: { timezone: true } }
      }
    })
    for (const connection of connections) {
      report.connections += 1
      try {
        await this.one(connection, now, report)
      } catch (error) {
        // One connection that fails does not stop the others; the next minute looks again
        report.failed += 1
        this.logger.error(
          { connectionId: connection.id, errorName: errorName(error) },
          'the pickups of a connection could not be evaluated'
        )
      }
    }
    try {
      report.swept = await this.sweep(now)
    } catch (error) {
      report.failed += 1
      this.logger.error({ errorName: errorName(error) }, 'the pickup sweep failed')
    }
    return report
  }

  private async one(
    connection: {
      id: string
      storeId: string
      carrierId: string
      store: { timezone: string }
    } & PickupScheduleRules,
    now: Date,
    report: PickupEvaluation
  ): Promise<void> {
    const plugin = this.registry.find(connection.carrierId)
    if (plugin === undefined) return
    const clock = storeClockOf(now, connection.store.timezone)
    const due = isAutoPickupDue(connection, clock)
    if (plugin.shipmentCreation === ShipmentCreationModes.PICKUP_BOUND) {
      // A pickup-bound carrier has its pickup with its guides: the run makes both, once a day
      if (due) report.guidesMade += await this.makeGuides(connection, clock.date)
      return
    }
    let waiting = await this.waiting(connection)
    if (due && waiting > 0) {
      // One failing step does not take the reminder with it: that is when the reminder matters most
      try {
        const result = await this.pickups.ensurePickup(
          connection.storeId,
          { connectionId: connection.id, actor: { type: 'system', id: null }, now },
          carrierId => this.registry.find(carrierId)
        )
        if (result.created) report.pickupsMade += 1
        if (result.sync && result.pickupId !== null) {
          await this.queueSync(connection.storeId, result.pickupId, result.revision)
        }
        if (result.joined.length > 0) waiting = await this.waiting(connection)
      } catch (error) {
        report.failed += 1
        this.logger.error(
          { connectionId: connection.id, errorName: errorName(error) },
          'the automatic pickup of a connection failed'
        )
      }
    }
    const reminder = cutoffReminderDue(connection, clock)
    if (reminder === null || waiting === 0) return
    // Once per connection and day, however many minutes the window lasts and however many replicas look
    const key = CacheKeys.pickup.cutoffReminder(connection.id, clock.date)
    const first = await this.redis.set(key, '1', 'EX', PickupSchedule.MEMORY_TTL_SECONDS, 'NX')
    if (first !== 'OK') return
    try {
      await this.prisma.transaction(tx => {
        this.events.publish(tx, Events.PICKUP_CUTOFF_APPROACHING, {
          storeId: connection.storeId,
          connectionId: connection.id,
          pickupDate: clock.date,
          waiting,
          minutesLeft: reminder.minutesLeft
        })
        return Promise.resolve()
      })
    } catch (error) {
      // The day's reminder was not raised: the next minute of the window tries again
      await this.redis.del(key).catch(() => undefined)
      throw error
    }
    report.reminders += 1
  }

  // The guides that wait for a pickup on a connection: a label made, no pickup yet
  private waiting(connection: { id: string; storeId: string }): Promise<number> {
    return this.prisma.client.shipment.count({
      where: {
        storeId: connection.storeId,
        connectionId: connection.id,
        kind: ShipmentKind.OUTBOUND,
        status: { in: [...PickupEligibleStatuses] },
        pickupId: null,
        guideNumber: { not: null }
      }
    })
  }

  // `autoPickup` of a pickup-bound carrier (TDD_17 §4.10): the guides and the pickup together for every confirmed or preparing order
  // planned for the connection that has no guide yet. It spends money without a click, so it is off by default, it goes through the
  // same engine and its validation as a manual run, and it is made once a day: what the engine refuses is not asked again each minute.
  private async makeGuides(
    connection: { id: string; storeId: string },
    day: string
  ): Promise<number> {
    const first = await this.redis.set(
      CacheKeys.pickup.autoRun(connection.id, day),
      '1',
      'EX',
      PickupSchedule.MEMORY_TTL_SECONDS,
      'NX'
    )
    if (first !== 'OK') return 0
    let made = 0
    try {
      // In pages by id: what the engine refuses stays an order with no guide, and a cursor passes it instead of asking again
      let after: string | undefined
      for (let page = 0; page < AUTO_RUN_MAX_PAGES; page += 1) {
        const orders = await this.prisma.client.order.findMany({
          where: {
            storeId: connection.storeId,
            carrierConnectionId: connection.id,
            status: { in: [OrderStatus.CONFIRMED, OrderStatus.PREPARING] },
            shipments: {
              none: {
                kind: ShipmentKind.OUTBOUND,
                status: { notIn: [...ShipmentInactiveStatuses] }
              }
            },
            ...(after === undefined ? {} : { id: { gt: after } })
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: AUTO_RUN_ORDERS
        })
        if (orders.length === 0) break
        const outcomes = await this.shipping.createShipments(
          connection.storeId,
          orders.map(order => ({ orderId: order.id, connectionId: connection.id })),
          { actor: { type: 'system', id: null }, canOverridePrice: false },
          carrierId => this.registry.find(carrierId)
        )
        made += outcomes.filter(outcome => outcome.ok).length
        after = orders.at(-1)?.id
        if (orders.length < AUTO_RUN_ORDERS) break
      }
    } catch (error) {
      // A run that failed before it finished is tried again the next minute (the orders that already have a guide are not asked again)
      await this.redis.del(CacheKeys.pickup.autoRun(connection.id, day)).catch(() => undefined)
      throw error
    }
    this.logger.info(
      { connectionId: connection.id, made },
      'an automatic pickup run asked for its guides'
    )
    return made
  }

  // What no job will do by itself: a pickup left PENDING because the queue was down or its job was lost, and a count the carrier has
  // not acknowledged for a while (two changes that landed out of order, a carrier that did not answer). Each is queued at most once
  // per bucket of time, with its own job id.
  private async sweep(now: Date): Promise<number> {
    const bucket = Math.floor(now.getTime() / PickupSchedule.SWEEP_BUCKET_MS)
    const pending = await this.prisma.client.pickupRequest.findMany({
      where: {
        status: PickupStatus.PENDING,
        createdAt: { lt: new Date(now.getTime() - PickupSchedule.PENDING_STALE_MS) }
      },
      select: { id: true, storeId: true },
      orderBy: { createdAt: 'asc' },
      take: PickupSchedule.SWEEP_BATCH
    })
    // The comparison of the two counts is in the query: filtered after a `take`, the pickups that agree (never touched again, so always
    // the oldest) would crowd out the ones that do not
    const behind = await this.prisma.client.$queryRaw<{ id: string; storeId: string }[]>`
      SELECT id, store_id AS "storeId"
      FROM pickup_requests
      WHERE status IN (${PickupStatus.REQUESTED}, ${PickupStatus.CONFIRMED})
        AND provider_pickup_id IS NOT NULL
        AND carrier_package_count IS NOT NULL
        AND carrier_package_count <> package_count
        AND package_count > 0
        AND updated_at < ${new Date(now.getTime() - PickupSchedule.RESYNC_AFTER_MS)}
      ORDER BY updated_at ASC
      LIMIT ${PickupSchedule.SWEEP_BATCH}`
    const jobs = [...pending, ...behind].map(pickup => ({
      name: JobNames.SYNC_PICKUP,
      data: { storeId: pickup.storeId, pickupId: pickup.id, requestedBy: null },
      opts: pickupSyncJobOptions(syncPickupSweepJobId(pickup.id, bucket))
    }))
    if (jobs.length > 0) await this.queue.addBulk(jobs)
    return jobs.length
  }

  private queueSync(storeId: string, pickupId: string, revision: number): Promise<unknown> {
    return this.queue.add(
      JobNames.SYNC_PICKUP,
      { storeId, pickupId, requestedBy: null },
      pickupSyncJobOptions(syncPickupJobId(pickupId, revision))
    )
  }
}
