import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'
import { ExistingPictureSweep } from '@platform/core/storage'

import { ExistingPictureSanitizer } from '../media/existing-picture-sanitizer.service'
import { VersionedBucketGuard } from '../media/versioned-bucket.guard'

import { LeaderLockService } from './leader-lock.service'

// The lock outlives a full run (a hundred pictures, one decoded at a time)
const LOCK_SECONDS = 540

// Every ten minutes, on one replica: the pictures stored before the cleaning of metadata existed, a bounded batch per run (see
// `ExistingPictureSanitizer`). It does nothing once every picture has been looked at.
@Injectable()
export class ExistingPicturesScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly sanitizer: ExistingPictureSanitizer,
    private readonly guard: VersionedBucketGuard,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExistingPicturesScheduler.name)
  }

  @Cron(Schedules.SANITIZE_EXISTING_PICTURES)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.SANITIZE_EXISTING_PICTURES, LOCK_SECONDS, async () => {
        // The sweep re-encodes customer pictures: it takes no batch unless the bucket can bring the original back (`VersionedBucketGuard`)
        if (!(await this.guard.allows(LockNames.SANITIZE_EXISTING_PICTURES))) return
        const report = await this.sanitizer.run()
        const handled = report.cleaned + report.alreadyClean + report.skipped
        if (handled + report.failed >= ExistingPictureSweep.MAX_PER_RUN) {
          this.logger.warn(report, 'a full batch of stored pictures was swept; more may wait')
        } else if (handled + report.failed > 0) {
          this.logger.info(report, 'stored pictures were swept for metadata')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next run tries again
      this.logger.error({ errorName: errorName(error) }, 'the sweep of stored pictures failed')
    }
  }
}
