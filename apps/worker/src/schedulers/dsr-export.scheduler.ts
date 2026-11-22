import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'

import { DsrExportRunner } from '../compliance/dsr-export.runner'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 1800
// The sweep starts no request in the last minutes of its lock
const TIME_BUDGET_MS = (LOCK_SECONDS - 120) * 1000

// Daily, on one replica: the approved access and portability exports are made and the expired files deleted (Step 7.2-H2b-2)
@Injectable()
export class DsrExportScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly runner: DsrExportRunner,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrExportScheduler.name)
  }

  @Cron(Schedules.EXPORT_DSR_REQUESTS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.EXPORT_DSR_REQUESTS, LOCK_SECONDS, async () => {
        const report = await this.runner.run(Date.now() + TIME_BUDGET_MS)
        if (report.failed > 0) {
          this.logger.warn(report, 'some data exports failed; the next run retries them')
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next day tries again
      this.logger.error({ errorName: errorName(error) }, 'the export of data requests failed')
    }
  }
}
