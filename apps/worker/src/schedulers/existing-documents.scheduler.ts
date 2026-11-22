import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'
import { ExistingDocumentSweep } from '@platform/core/storage'

import { ExistingDocumentSanitizer } from '../media/existing-document-sanitizer.service'
import { VersionedBucketGuard } from '../media/versioned-bucket.guard'

import { LeaderLockService } from './leader-lock.service'

// The lock outlives a full run (forty documents, one parsed at a time)
const LOCK_SECONDS = 540

// Every ten minutes, on one replica: the PDF, docx and xlsx stored before their cleaning existed, a bounded batch per run (see
// `ExistingDocumentSanitizer`). It rewrites customer files, so it takes no batch unless the bucket can bring the original back
// (`VersionedBucketGuard`).
@Injectable()
export class ExistingDocumentsScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly sanitizer: ExistingDocumentSanitizer,
    private readonly guard: VersionedBucketGuard,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExistingDocumentsScheduler.name)
  }

  @Cron(Schedules.SANITIZE_EXISTING_DOCUMENTS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.SANITIZE_EXISTING_DOCUMENTS, LOCK_SECONDS, async () => {
        // Asked inside the lock, so that replicas do not all ask; a "no" ends the run before anything is read
        if (!(await this.guard.allows(LockNames.SANITIZE_EXISTING_DOCUMENTS))) return
        const report = await this.sanitizer.run()
        const handled = report.cleaned + report.alreadyClean + report.skipped
        if (handled + report.failed >= ExistingDocumentSweep.MAX_PER_RUN) {
          this.logger.warn(report, 'a full batch of stored documents was swept; more may wait')
        } else if (handled + report.failed > 0) {
          this.logger.info(report, 'stored documents were swept for metadata')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next run tries again
      this.logger.error({ errorName: errorName(error) }, 'the sweep of stored documents failed')
    }
  }
}
