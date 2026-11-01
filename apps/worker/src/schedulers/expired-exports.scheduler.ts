import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { ExportLimits } from '@platform/core/exports'
import { LockNames, Schedules } from '@platform/core/queues'

import { ExpiredExportsCleaner } from '../exports/expired-exports-cleaner.service'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 600

// Hourly, on one replica
@Injectable()
export class ExpiredExportsScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly cleaner: ExpiredExportsCleaner,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExpiredExportsScheduler.name)
  }

  @Cron(Schedules.CLEAN_EXPIRED_EXPORTS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CLEAN_EXPIRED_EXPORTS, LOCK_SECONDS, async () => {
        const report = await this.cleaner.run()
        if (report.filesDeleted >= ExportLimits.CLEANUP_BATCH) {
          this.logger.warn(report, 'a full batch of expired exports was deleted; more may wait')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next hour tries again
      this.logger.error({ errorName: errorName(error) }, 'the cleanup of expired exports failed')
    }
  }
}
