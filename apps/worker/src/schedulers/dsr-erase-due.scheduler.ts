import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'

import { DsrEraseDueSweeper } from '../compliance/dsr-erase-due.sweeper'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 1800
// The sweep starts no request in the last minutes of its lock
const TIME_BUDGET_MS = (LOCK_SECONDS - 120) * 1000

// Daily, on one replica: the approved erasures of data requests whose grace period ended are carried out (Step 7.2-H2b-1)
@Injectable()
export class DsrEraseDueScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly sweeper: DsrEraseDueSweeper,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrEraseDueScheduler.name)
  }

  @Cron(Schedules.ERASE_DSR_REQUESTS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.ERASE_DSR_REQUESTS, LOCK_SECONDS, async () => {
        const report = await this.sweeper.run(Date.now() + TIME_BUDGET_MS)
        if (report.failed > 0) {
          this.logger.warn(report, 'some data erasures failed; the next run retries them')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next day tries again
      this.logger.error({ errorName: errorName(error) }, 'the erasure of due data requests failed')
    }
  }
}
