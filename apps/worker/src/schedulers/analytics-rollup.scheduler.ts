import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { RollupLimits } from '@platform/core/analytics'
import { PrismaService } from '@platform/core/database'
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
  RollupGranularities,
  type RollupGranularity
} from '../analytics/rollup-periods'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 300

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
    private readonly logger: PinoLogger
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
    let cursor: string | undefined
    for (;;) {
      const stores = await this.prisma.client.store.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
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
    return queued
  }
}
