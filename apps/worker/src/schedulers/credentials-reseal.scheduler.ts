import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { CredentialsReseal } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  JobNames,
  LockNames,
  QueueNames,
  resealCredentialsJobId,
  type ResealCredentialsJob,
  Schedules
} from '@platform/core/queues'

import { CredentialsResealer } from '../credentials/credentials-resealer.service'

import { LeaderLockService } from './leader-lock.service'

// rls-context: the organizations are a global table (no row security); the job opens the context of its organization

const LOCK_SECONDS = 600
const DAY_LENGTH = 10 // "2026-11-12" in an ISO date

// Daily at 04:45 UTC, on one replica, ONLY while the deployment holds a previous key (Step 7.3-S11c): one re-seal job for EVERY organization,
// with books or without them (the fiscal re-seal rides on the books and misses the ones that have none). Without a previous key nothing is
// queued and nothing is read. The job is the heavy-processing job, so a slow organization does not hold the lock of the schedule.
@Injectable()
export class CredentialsResealScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<ResealCredentialsJob>,
    private readonly prisma: PrismaService,
    private readonly resealer: CredentialsResealer,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(CredentialsResealScheduler.name)
  }

  @Cron(Schedules.RESEAL_CREDENTIALS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.RESEAL_CREDENTIALS, LOCK_SECONDS, async () => {
        const queued = await this.enqueueAll(new Date())
        if (queued > 0)
          this.logger.info(
            { offered: queued },
            'the re-seal of the credentials was offered to the queue'
          )
      })
    } catch (error) {
      // A cron that throws must not take the worker down; tomorrow it tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the re-seal of the credentials was not queued'
      )
    }
  }

  // The job id carries the organization and the UTC day: the same day asked twice is one job, whatever the replica
  async enqueueAll(now: Date, options: { pageSize?: number } = {}): Promise<number> {
    if (!this.resealer.enabled) return 0
    const pageSize = options.pageSize ?? CredentialsReseal.ORGANIZATIONS_PAGE_SIZE
    const day = now.toISOString().slice(0, DAY_LENGTH)
    let queued = 0
    let cursor: string | undefined
    for (;;) {
      const page = await this.prisma.client.organization.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      if (page.length > 0) {
        await this.heavyQueue.addBulk(
          page.map(organization => ({
            name: JobNames.RESEAL_CREDENTIALS,
            data: { organizationId: organization.id },
            opts: {
              jobId: resealCredentialsJobId(organization.id, day),
              attempts: CredentialsReseal.JOB_ATTEMPTS,
              backoff: { type: 'exponential' as const, delay: CredentialsReseal.JOB_BACKOFF_MS },
              // The job data is only an id, but a failed job must not stay to block the same day
              removeOnFail: true
            }
          }))
        )
        queued += page.length
      }
      if (page.length < pageSize) break
      cursor = page.at(-1)?.id
    }
    return queued
  }
}
