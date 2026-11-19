import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { RollupLimits } from '@platform/core/analytics'
import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import { errorName } from '@platform/core/errors'
import {
  JobNames,
  LockNames,
  QueueNames,
  type RollupJob,
  rollupJobId,
  Schedules
} from '@platform/core/queues'

import {
  periodsToRecompute,
  type RollupPeriod,
  RollupGranularities,
  type RollupGranularity
} from '../analytics/rollup-periods'

import { LeaderLockService } from './leader-lock.service'

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

const LOCK_SECONDS = 300
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

const JobNameOf = {
  [RollupGranularities.HOURLY]: JobNames.ROLLUP_HOURLY,
  [RollupGranularities.DAILY]: JobNames.ROLLUP_DAILY
} as const

const LockNameOf = {
  [RollupGranularities.HOURLY]: LockNames.ROLLUP_HOURLY,
  [RollupGranularities.DAILY]: LockNames.ROLLUP_DAILY
} as const

// The rollups of TDD_08 §6, on one replica: at :05 of every hour the two latest closed hours of every store, and at 00:15 UTC the
// two latest closed days. One job for each store and period, so a slow store does not hold the others or the lock of the schedule.
@Injectable()
export class AnalyticsRollupScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.ANALYTICS) private readonly queue: Queue<RollupJob>,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(AnalyticsRollupScheduler.name)
  }

  @Cron(Schedules.ROLLUP_HOURLY)
  runHourly(): Promise<void> {
    return this.run(RollupGranularities.HOURLY)
  }

  @Cron(Schedules.ROLLUP_DAILY)
  runDaily(): Promise<void> {
    return this.run(RollupGranularities.DAILY)
  }

  private async run(granularity: RollupGranularity): Promise<void> {
    try {
      await this.locks.withLock(LockNameOf[granularity], LOCK_SECONDS, async () => {
        const queued = await this.enqueueAll(granularity, new Date())
        this.logger.info({ granularity, queued }, 'analytics rollups queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next run recomputes the same periods
      this.logger.error({ granularity, errorName: errorName(error) }, 'the rollups were not queued')
    }
  }

  async enqueueAll(
    granularity: RollupGranularity,
    now: Date,
    options: { pageSize?: number } = {}
  ): Promise<number> {
    const pageSize = options.pageSize ?? RollupLimits.STORES_PAGE_SIZE
    const periods = periodsToRecompute(granularity, now)
    // The run is the period that was running when the schedule fired: it names the jobs of this run and no other
    const runStart = new Date(periods[0]?.end ?? now)
    let queued = 0
    const storeIds: string[] = []
    let cursor: string | undefined
    for (;;) {
      const stores = await this.prisma.client.store.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      storeIds.push(...stores.map(store => store.id))
      if (stores.length > 0) {
        await this.queue.addBulk(
          stores.flatMap(store =>
            periods.map(period => ({
              name: JobNameOf[granularity],
              data: {
                storeId: store.id,
                periodStart: period.start.toISOString(),
                periodEnd: period.end.toISOString()
              },
              opts: {
                jobId: rollupJobId(JobNameOf[granularity], store.id, period.start, runStart)
              }
            }))
          )
        )
        queued += stores.length * periods.length
      }
      if (stores.length < pageSize) break
      cursor = stores.at(-1)?.id
    }
    if (granularity === RollupGranularities.DAILY) {
      queued += await this.enqueueLateDays(now, periods, runStart, storeIds)
    }
    return queued
  }

  // An order cancelled or adjusted after its day left the recompute window would keep that day's count and revenue for good. The
  // day of an order that changed in the last LATE_ORDER_CHANGE_HOURS goes back through the rollup, if it is not older than
  // LATE_ORDER_LOOKBACK_DAYS. The figure stays dated by when the order was made; it is the day that is corrected, not today.
  private async enqueueLateDays(
    now: Date,
    window: readonly RollupPeriod[],
    runStart: Date,
    storeIds: readonly string[]
  ): Promise<number> {
    const windowStart = window.at(-1)?.start ?? now
    const changedSince = new Date(now.getTime() - RollupLimits.LATE_ORDER_CHANGE_HOURS * HOUR_MS)
    const oldest = new Date(now.getTime() - RollupLimits.LATE_ORDER_LOOKBACK_DAYS * DAY_MS)
    const days = new Map<string, Set<number>>()
    // The orders of each store are read in the context of that store, one context for each page (a context lasts 15 s); a store that is
    // deleted meanwhile has no late days
    for (const storeId of storeIds) {
      let cursor: string | undefined
      for (;;) {
        let orders: { id: string; createdAt: Date }[]
        try {
          orders = await this.jobContext.forStore(storeId, () =>
            this.prisma.client.order.findMany({
              where: {
                storeId,
                updatedAt: { gte: changedSince },
                createdAt: { gte: oldest, lt: windowStart }
              },
              select: { id: true, createdAt: true },
              orderBy: { id: 'asc' },
              take: RollupLimits.LATE_ORDER_PAGE_SIZE,
              ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
            })
          )
        } catch (error) {
          if (error instanceof JobContextGoneError) break
          throw error
        }
        for (const order of orders) {
          const start = Math.floor(order.createdAt.getTime() / DAY_MS) * DAY_MS
          const of = days.get(storeId) ?? new Set<number>()
          of.add(start)
          days.set(storeId, of)
        }
        if (orders.length < RollupLimits.LATE_ORDER_PAGE_SIZE) break
        cursor = orders.at(-1)?.id
      }
    }
    const jobs = [...days].flatMap(([storeId, starts]) =>
      [...starts].map(start => ({
        name: JobNames.ROLLUP_DAILY,
        data: {
          storeId,
          periodStart: new Date(start).toISOString(),
          periodEnd: new Date(start + DAY_MS).toISOString()
        },
        opts: { jobId: rollupJobId(JobNames.ROLLUP_DAILY, storeId, new Date(start), runStart) }
      }))
    )
    // In batches, like the stores: a bulk change of old orders must not build one giant request
    for (let from = 0; from < jobs.length; from += RollupLimits.LATE_ORDER_PAGE_SIZE) {
      await this.queue.addBulk(jobs.slice(from, from + RollupLimits.LATE_ORDER_PAGE_SIZE))
    }
    return jobs.length
  }
}
