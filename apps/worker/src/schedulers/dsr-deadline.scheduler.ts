import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'

import { DsrDeadlineChecker } from '../compliance/dsr-deadline.checker'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 600

// Daily, on one replica: the reviewers are told of the data requests close to their legal deadline (Step 7.2-H2b-2)
@Injectable()
export class DsrDeadlineScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly checker: DsrDeadlineChecker,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrDeadlineScheduler.name)
  }

  @Cron(Schedules.CHECK_DSR_DEADLINES)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CHECK_DSR_DEADLINES, LOCK_SECONDS, async () => {
        await this.checker.run()
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next day tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the check of data request deadlines failed'
      )
    }
  }
}
