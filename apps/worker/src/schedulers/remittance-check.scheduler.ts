import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { RemittableCodStatuses } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  type CheckRemittancesJob,
  checkRemittancesJobId,
  JobNames,
  LockNames,
  QueueNames,
  Schedules
} from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 300
const DAY_LENGTH = 10 // "2026-11-12" in an ISO date
const PAGE_SIZE = 500

// Daily at 15:00 UTC, on one replica (TDD_17 §4.15): one check job for each store that has cash on delivery still owed. The
// check itself is a job of the notifications queue, so a store with many shipments does not hold the lock of the schedule.
@Injectable()
export class RemittanceCheckScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.NOTIFICATIONS)
    private readonly queue: Queue<CheckRemittancesJob>,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(RemittanceCheckScheduler.name)
  }

  @Cron(Schedules.CHECK_REMITTANCES)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CHECK_REMITTANCES, LOCK_SECONDS, async () => {
        const queued = await this.enqueueAll(new Date())
        this.logger.info({ queued }, 'remittance checks queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; tomorrow it tries again
      this.logger.error({ errorName: errorName(error) }, 'the remittance checks were not queued')
    }
  }

  // The job id carries the store and the UTC day: the same day asked twice is one job, whatever the replica
  async enqueueAll(now: Date, options: { pageSize?: number } = {}): Promise<number> {
    const pageSize = options.pageSize ?? PAGE_SIZE
    const day = now.toISOString().slice(0, DAY_LENGTH)
    let queued = 0
    let cursor: string | undefined
    for (;;) {
      const stores = await this.prisma.client.store.findMany({
        where: { shipments: { some: { codStatus: { in: [...RemittableCodStatuses] } } } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      if (stores.length > 0) {
        await this.queue.addBulk(
          stores.map(store => ({
            name: JobNames.CHECK_REMITTANCES,
            data: { storeId: store.id },
            opts: { jobId: checkRemittancesJobId(store.id, day) }
          }))
        )
        queued += stores.length
      }
      if (stores.length < pageSize) break
      cursor = stores.at(-1)?.id
    }
    return queued
  }
}
