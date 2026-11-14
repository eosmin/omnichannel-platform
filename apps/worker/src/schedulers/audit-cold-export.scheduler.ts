import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditColdExport } from '@platform/core/compliance'
import { DAY_MS } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  type ExportAuditLogsJob,
  exportAuditLogsJobId,
  JobNames,
  LockNames,
  QueueNames,
  Schedules
} from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 300
const MONTH_LENGTH = 7 // "2026-11" in an ISO date

// Monthly at 02:00 UTC on the 1st, on one replica (TDD_05 §9.3): queues the cold export of the audit log, with the
// instant before which an entry may leave the database (now minus the two years of the hot window). The export itself
// is the job of the exports queue, which reads and uploads a month at a time. The job id is the month of the run.
@Injectable()
export class AuditColdExportScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.EXPORTS) private readonly exportsQueue: Queue<ExportAuditLogsJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(AuditColdExportScheduler.name)
  }

  @Cron(Schedules.EXPORT_AUDIT_LOGS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.EXPORT_AUDIT_LOGS, LOCK_SECONDS, async () => {
        await this.enqueue(new Date())
      })
    } catch (error) {
      // A cron that throws must not take the worker down; next month it tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the cold export of the audit log was not queued'
      )
    }
  }

  async enqueue(now: Date): Promise<void> {
    const before = new Date(now.getTime() - AuditColdExport.HOT_DAYS * DAY_MS)
    await this.exportsQueue.add(
      JobNames.EXPORT_AUDIT_LOGS_TO_COLD_STORAGE,
      { before: before.toISOString() },
      { jobId: exportAuditLogsJobId(now.toISOString().slice(0, MONTH_LENGTH)) }
    )
    this.logger.info(
      { before: before.toISOString() },
      'the cold export of the audit log was queued'
    )
  }
}
