import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import { FinanceSweepLimits } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  JobNames,
  LockNames,
  QueueNames,
  verifyLedgerChainJobId,
  type VerifyLedgerChainJob,
  Schedules
} from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'

// rls-context: the organizations are a global table (no row security); the settings of the books are read inside forOrganization

const LOCK_SECONDS = 600
const DAY_LENGTH = 10 // "2026-11-12" in an ISO date

// Sundays at 05:00 UTC, on one replica (TDD_18 §11): one check of the hash chain for each organization that has set up its books. The walk
// is the heavy-processing job (it reads the whole journal), so a slow organization does not hold the lock of the schedule.
@Injectable()
export class FinanceChainScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<VerifyLedgerChainJob>,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(FinanceChainScheduler.name)
  }

  @Cron(Schedules.VERIFY_LEDGER_CHAIN)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.VERIFY_LEDGER_CHAIN, LOCK_SECONDS, async () => {
        const queued = await this.enqueueAll(new Date())
        this.logger.info({ queued }, 'the weekly check of the chain was queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; tomorrow it tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the weekly check of the chain was not queued'
      )
    }
  }

  // The job id carries the organization and the UTC day: the same run asked twice is one job, whatever the replica
  async enqueueAll(now: Date, options: { pageSize?: number } = {}): Promise<number> {
    const pageSize = options.pageSize ?? FinanceSweepLimits.ORGANIZATIONS_PAGE_SIZE
    const day = now.toISOString().slice(0, DAY_LENGTH)
    let queued = 0
    let cursor: string | undefined
    for (;;) {
      // The organizations are not behind row security; whether one has set up its books is (finance_settings is), so it is asked from the
      // context of that organization, one at a time (a page of ids is short)
      const page = await this.prisma.client.organization.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      const settings: { organizationId: string }[] = []
      for (const organization of page) {
        // One organization whose context fails must not leave the rest of the page without its night: it is queued anyway (the job
        // itself ends when there are no books) and the failure is logged
        let queue = true
        try {
          queue = await this.hasBooks(organization.id)
        } catch (error) {
          this.logger.warn(
            { organizationId: organization.id, errorName: errorName(error) },
            'the books of an organization could not be looked up: it is queued anyway'
          )
        }
        if (queue) settings.push({ organizationId: organization.id })
      }
      if (settings.length > 0) {
        await this.heavyQueue.addBulk(
          settings.map(row => ({
            name: JobNames.VERIFY_LEDGER_CHAIN,
            data: { organizationId: row.organizationId },
            opts: {
              jobId: verifyLedgerChainJobId(row.organizationId, day),
              // A blip of the database must not cost the week: it is tried again, and a failed job does not stay to block the same day
              attempts: FinanceSweepLimits.JOB_ATTEMPTS,
              backoff: { type: 'exponential' as const, delay: FinanceSweepLimits.JOB_BACKOFF_MS },
              removeOnFail: true
            }
          }))
        )
        queued += settings.length
      }
      if (page.length < pageSize) break
      cursor = page.at(-1)?.id
    }
    return queued
  }

  // A context that cannot see the settings of its own organization would read as "no books" and skip the night: the organization row
  // is read first (not behind row security), and an organization deleted since the page was read is skipped
  private async hasBooks(organizationId: string): Promise<boolean> {
    try {
      const settings = await this.jobContext.forOrganization(organizationId, () =>
        this.prisma.client.financeSettings.findUnique({
          where: { organizationId },
          select: { organizationId: true }
        })
      )
      return settings !== null
    } catch (error) {
      if (error instanceof JobContextGoneError) return false
      throw error
    }
  }
}
