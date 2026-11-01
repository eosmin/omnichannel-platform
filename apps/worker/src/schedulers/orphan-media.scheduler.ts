import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { LockNames, Schedules } from '@platform/core/queues'
import { UploadLimits } from '@platform/core/storage'

import { OrphanMediaCleaner } from '../media/orphan-media-cleaner.service'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 900

// Hourly, on one replica: what the uploads and the scans leave behind when something dies half way
@Injectable()
export class OrphanMediaScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly cleaner: OrphanMediaCleaner,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OrphanMediaScheduler.name)
  }

  @Cron(Schedules.CLEAN_ORPHAN_MEDIA)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CLEAN_ORPHAN_MEDIA, LOCK_SECONDS, async () => {
        const report = await this.cleaner.run()
        if (report.objectsDeleted >= UploadLimits.ORPHAN_CLEANUP_BATCH) {
          this.logger.warn(report, 'a full batch of stray files was deleted; more may wait')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next hour tries again
      this.logger.error({ errorName: errorName(error) }, 'the cleanup of stray media failed')
    }
  }
}
