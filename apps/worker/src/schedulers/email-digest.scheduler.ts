import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { DigestFrequency } from '@platform/core/domain'
import { LockNames, Schedules } from '@platform/core/queues'

import { EmailDigestService } from '../notifications/email-digest.service'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 300

// Every hour at :10 (TDD_07 §4): queues the digest of the people who chose hourly, and, when their own
// clock reads 08:00, of those who chose daily. The two schedules share the expression and not the lock.
@Injectable()
export class EmailDigestScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly digest: EmailDigestService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(EmailDigestScheduler.name)
  }

  @Cron(Schedules.SEND_EMAIL_DIGEST_HOURLY)
  async hourly(): Promise<void> {
    await this.run(LockNames.SEND_EMAIL_DIGEST_HOURLY, DigestFrequency.HOURLY)
  }

  @Cron(Schedules.SEND_EMAIL_DIGEST_DAILY)
  async daily(): Promise<void> {
    await this.run(LockNames.SEND_EMAIL_DIGEST_DAILY, DigestFrequency.DAILY)
  }

  private async run(
    lock: string,
    frequency: DigestFrequency.HOURLY | DigestFrequency.DAILY
  ): Promise<void> {
    try {
      await this.locks.withLock(lock, LOCK_SECONDS, async () => {
        const report = await this.digest.scan(frequency, new Date())
        if (report.full) {
          this.logger.warn(
            report,
            'a full batch of people was queued for the digest; more may wait'
          )
        }
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next hour tries again
      this.logger.error({ errorName: errorName(error), frequency }, 'the email digest scan failed')
    }
  }
}
