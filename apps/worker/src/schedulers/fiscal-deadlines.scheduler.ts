import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { FiscalDeadlineSweep } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  JobNames,
  LockNames,
  QueueNames,
  Schedules,
  warnFiscalDeadlinesJobId,
  type WarnFiscalDeadlinesJob
} from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'

// rls-context: the organizations are a global table (no row security); the job opens the context of its organization

const LOCK_SECONDS = 300
const HOUR_LENGTH = 13 // "2026-11-12T09" in an ISO date

// Hourly (twenty past), on one replica (D14b): one look at the windows of the authority for each organization. The windows are 24 hours
// long (a refused document, the event of a contingency), so a daily look could tell the person at 36 hours; this one tells at the first hour
// after the closing stretch begins. The look itself is the heavy-processing job, so a slow organization does not hold the lock of the
// schedule, and each page of organizations is bounded.
@Injectable()
export class FiscalDeadlinesScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<WarnFiscalDeadlinesJob>,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalDeadlinesScheduler.name)
  }

  @Cron(Schedules.WARN_FISCAL_DEADLINES)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.WARN_FISCAL_DEADLINES, LOCK_SECONDS, async () => {
        const queued = await this.enqueueAll(new Date())
        this.logger.info({ queued }, 'the look at the fiscal windows was queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next hour tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the look at the fiscal windows was not queued'
      )
    }
  }

  // The job id carries the organization and the UTC hour: the same hour asked twice is one job, whatever the replica
  async enqueueAll(now: Date, options: { pageSize?: number } = {}): Promise<number> {
    const pageSize = options.pageSize ?? FiscalDeadlineSweep.ORGANIZATIONS_PAGE_SIZE
    const hour = now.toISOString().slice(0, HOUR_LENGTH).replace('T', '-')
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
            name: JobNames.WARN_FISCAL_DEADLINES,
            data: { organizationId: organization.id },
            opts: {
              jobId: warnFiscalDeadlinesJobId(organization.id, hour),
              attempts: FiscalDeadlineSweep.JOB_ATTEMPTS,
              backoff: { type: 'exponential' as const, delay: FiscalDeadlineSweep.JOB_BACKOFF_MS },
              // Ids only, and a failed job must not stay to block the same hour
              removeOnFail: true,
              // Kept for the hour, so a second replica or a restart asking for the same job id finds it and adds nothing
              removeOnComplete: { age: 3600 }
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
