import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'

import { BulkLabelsCleaner } from '../shipping/bulk-labels-cleaner.service'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 600

// Daily, on one replica (`CLEAN_BULK_LABELS`): the merged files past their days, and the runs that were lost
@Injectable()
export class BulkLabelsScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly cleaner: BulkLabelsCleaner,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(BulkLabelsScheduler.name)
  }

  @Cron(Schedules.CLEAN_BULK_LABELS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CLEAN_BULK_LABELS, LOCK_SECONDS, async () => {
        const report = await this.cleaner.run()
        if (report.filesDeleted > 0 || report.jobsClosed > 0) {
          this.logger.info(report, 'the leftovers of the bulk labels were cleaned')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next day tries again
      this.logger.error({ errorName: errorName(error) }, 'the cleanup of bulk labels failed')
    }
  }
}
