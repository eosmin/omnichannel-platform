import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { RetentionRun } from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { errorName } from '@platform/core/errors'
import {
  type EnforceRetentionJob,
  enforceRetentionJobId,
  JobNames,
  LockNames,
  QueueNames,
  Schedules
} from '@platform/core/queues'

import { localClockOf } from '../retention/retention-clock'

import { LeaderLockService } from './leader-lock.service'

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

const LOCK_SECONDS = 300

// Hourly, on one replica (TDD_05 §10.4): a retention job for each store whose own clock reads 03:00 now, so every store
// is done once a day at its own 03:00 and the work is spread over the day. The job id carries the store and its local
// day: the hour asked twice (two ticks, or a clock change that reads 03:00 twice) is one job. The deletion itself
// is the heavy-processing job, so a slow store does not hold the lock of the schedule.
@Injectable()
export class RetentionScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<EnforceRetentionJob>,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(RetentionScheduler.name)
  }

  @Cron(Schedules.ENFORCE_RETENTION)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.ENFORCE_RETENTION, LOCK_SECONDS, async () => {
        const queued = await this.enqueueDue(new Date())
        if (queued > 0) this.logger.info({ queued }, 'retention runs queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the stores of this hour wait for tomorrow
      this.logger.error({ errorName: errorName(error) }, 'the retention runs were not queued')
    }
  }

  async enqueueDue(now: Date, options: { pageSize?: number } = {}): Promise<number> {
    const pageSize = options.pageSize ?? RetentionRun.STORES_PAGE_SIZE
    let queued = 0
    let cursor: string | undefined
    for (;;) {
      const stores = await this.prisma.client.store.findMany({
        select: { id: true, timezone: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      const due: { id: string; day: string }[] = []
      for (const store of stores) {
        // A zone this engine does not know is read as UTC, said once a tick: the store is retained, never skipped
        let clock = localClockOf(now, store.timezone)
        if (clock === null) {
          this.logger.warn(
            { storeId: store.id },
            'a store has a time zone this engine does not know; UTC is used'
          )
          clock = localClockOf(now, 'UTC')
        }
        if (clock !== null && clock.hour === RetentionRun.LOCAL_HOUR) {
          due.push({ id: store.id, day: clock.day })
        }
      }
      if (due.length > 0) {
        // A page that cannot be queued (Redis) does not keep the stores of the next pages from their only hour of the day
        try {
          await this.heavyQueue.addBulk(
            due.map(store => ({
              name: JobNames.ENFORCE_RETENTION,
              data: { storeId: store.id },
              opts: { jobId: enforceRetentionJobId(store.id, store.day) }
            }))
          )
          queued += due.length
        } catch (error) {
          this.logger.error(
            { stores: due.length, errorName: errorName(error) },
            'a page of retention runs was not queued'
          )
        }
      }
      if (stores.length < pageSize) break
      cursor = stores.at(-1)?.id
    }
    return queued
  }
}
