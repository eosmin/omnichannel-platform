import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'

import { DsrExpireSweeper } from '../compliance/dsr-expire.sweeper'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 600

// Daily, on one replica: the data requests whose verification link expired unused are closed (Step 7.2-H1b)
@Injectable()
export class DsrExpireScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly sweeper: DsrExpireSweeper,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrExpireScheduler.name)
  }

  @Cron(Schedules.EXPIRE_DSR_REQUESTS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.EXPIRE_DSR_REQUESTS, LOCK_SECONDS, async () => {
        const report = await this.sweeper.run()
        if (report.failed > 0) {
          this.logger.warn(report, 'some data requests could not be closed; the next run retries')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next day tries again
      this.logger.error({ errorName: errorName(error) }, 'the expiry of data requests failed')
    }
  }
}
