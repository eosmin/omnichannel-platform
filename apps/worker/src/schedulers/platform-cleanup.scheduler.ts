import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'

import { ErasedCustomerSweep } from '../retention/erased-customer-sweep.service'
import { PlatformCleaner } from '../retention/platform-cleaner.service'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 1800
const SWEEP_MARGIN_SECONDS = 300

// Daily at 01:00 UTC, on one replica (TDD_05 §10.4): sessions, verification tokens, webhook deliveries, hourly rollups and
// merges past their window, and the data of the erased customers that was not all cleared. It runs here and not in a queue: it is deletes in batches, and the lock holds the next
// replica off until it ends.
@Injectable()
export class PlatformCleanupScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly cleaner: PlatformCleaner,
    private readonly erased: ErasedCustomerSweep,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PlatformCleanupScheduler.name)
  }

  @Cron(Schedules.CLEANUP_PLATFORM_DATA)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CLEANUP_PLATFORM_DATA, LOCK_SECONDS, async () => {
        const started = Date.now()
        // Apart: a category that fails in one does not keep the other from running
        await this.cleaner.run().catch(error => {
          this.logger.error({ errorName: errorName(error) }, 'the platform cleanup failed')
        })
        // The sweep stops starting customers a few minutes before the lock would expire (it is not renewed)
        await this.erased.run(started + (LOCK_SECONDS - SWEEP_MARGIN_SECONDS) * 1000)
      })
    } catch (error) {
      // A cron that throws must not take the worker down; tomorrow it tries again
      this.logger.error({ errorName: errorName(error) }, 'the platform cleanup failed')
    }
  }
}
