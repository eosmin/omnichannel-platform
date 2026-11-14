import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  isReportDue,
  localMoment,
  madeOnDay,
  type ReportFrequencyType
} from '@platform/core/analytics'
import { PrismaService } from '@platform/core/database'
import { errorName } from '@platform/core/errors'
import {
  type GenerateScheduledReportJob,
  JobNames,
  LockNames,
  QueueNames,
  scheduledReportJobId,
  Schedules
} from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 300
const PAGE_SIZE = 200

// Every hour on the hour (TDD_11 §7.4), on one replica: queues the reports whose own clock reads their hour today. The job is named
// by the report and the day of its zone, so the schedule run twice in an hour asks for the same job.
@Injectable()
export class ReportDispatchScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.EXPORTS) private readonly queue: Queue<GenerateScheduledReportJob>,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ReportDispatchScheduler.name)
  }

  @Cron(Schedules.DISPATCH_REPORTS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.DISPATCH_REPORTS, LOCK_SECONDS, async () => {
        const queued = await this.dispatch(new Date())
        this.logger.info({ queued }, 'scheduled reports queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next hour looks again
      this.logger.error({ errorName: errorName(error) }, 'the scheduled reports were not queued')
    }
  }

  async dispatch(now: Date, pageSize: number = PAGE_SIZE): Promise<number> {
    let queued = 0
    let cursor: string | undefined
    for (;;) {
      const reports = await this.prisma.client.scheduledReport.findMany({
        where: { enabled: true },
        select: { id: true, frequency: true, timezone: true, sendAtHour: true, lastSentAt: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      const due = reports.flatMap(report => {
        try {
          const local = localMoment(now, report.timezone)
          return isReportDue(report.frequency as ReportFrequencyType, local, report.sendAtHour) &&
            !madeOnDay(report.lastSentAt, report.timezone, local.day)
            ? [{ report, day: local.day }]
            : []
        } catch (error) {
          // A zone the runtime does not know any more costs that report, not the run of every store
          this.logger.error(
            { reportId: report.id, errorName: errorName(error) },
            'a report has no usable clock'
          )
          return []
        }
      })
      if (due.length > 0) {
        await this.queue.addBulk(
          due.map(({ report, day }) => ({
            name: JobNames.GENERATE_SCHEDULED_REPORT,
            data: { reportId: report.id, day },
            opts: { jobId: scheduledReportJobId(report.id, day) }
          }))
        )
        queued += due.length
      }
      if (reports.length < pageSize) break
      cursor = reports.at(-1)?.id
    }
    return queued
  }
}
