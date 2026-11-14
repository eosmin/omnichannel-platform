import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'

import { PlatformCleaner } from '../retention/platform-cleaner.service'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 1800

// Daily at 01:00 UTC, on one replica (TDD_05 §10.4): sessions, verification tokens, webhook deliveries, hourly rollups and
// merges past their window. It runs here and not in a queue: it is deletes in batches, and the lock holds the next
// replica off until it ends.
@Injectable()
export class PlatformCleanupScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly cleaner: PlatformCleaner,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PlatformCleanupScheduler.name)
  }

  @Cron(Schedules.CLEANUP_PLATFORM_DATA)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CLEANUP_PLATFORM_DATA, LOCK_SECONDS, async () => {
        await this.cleaner.run()
      })
    } catch (error) {
      // A cron that throws must not take the worker down; tomorrow it tries again
      this.logger.error({ errorName: errorName(error) }, 'the platform cleanup failed')
    }
  }
}
