import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'
import { ExistingAvSweep } from '@platform/core/storage'

import { ExistingAvSanitizer } from '../media/existing-av-sanitizer.service'
import { VersionedBucketGuard } from '../media/versioned-bucket.guard'

import { LeaderLockService } from './leader-lock.service'

// The lock outlives a full run: the run stops taking files after MAX_RUN_MS and the last one takes up to a few minutes (a slow bucket, three
// children of 20 s, the writes), so the margin is wide and a second replica never overlaps it
const LOCK_SECONDS = 900

// Every ten minutes, on one replica: the video and audio stored before their cleaning existed, a small batch per run (see
// `ExistingAvSanitizer`). It rewrites customer files, so it takes no batch unless the bucket can bring the original back
// (`VersionedBucketGuard`).
@Injectable()
export class ExistingAvScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly sanitizer: ExistingAvSanitizer,
    private readonly guard: VersionedBucketGuard,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExistingAvScheduler.name)
  }

  @Cron(Schedules.SANITIZE_EXISTING_AV)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.SANITIZE_EXISTING_AV, LOCK_SECONDS, async () => {
        // Asked inside the lock, so that replicas do not all ask; a "no" ends the run before anything is read
        if (!(await this.guard.allows(LockNames.SANITIZE_EXISTING_AV))) return
        const report = await this.sanitizer.run()
        const handled = report.cleaned + report.kept + report.unavailable + report.skipped
        if (handled + report.failed >= ExistingAvSweep.MAX_PER_RUN) {
          this.logger.warn(
            report,
            'a full batch of stored video and audio was swept; more may wait'
          )
        } else if (handled + report.failed > 0) {
          this.logger.info(report, 'stored video and audio were swept for metadata')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next run tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the sweep of stored video and audio failed'
      )
    }
  }
}
