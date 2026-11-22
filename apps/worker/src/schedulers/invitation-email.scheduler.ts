import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { LockNames, Schedules } from '@platform/core/queues'

import { InvitationEmailDelivery } from '../invitations/invitation-email-delivery.service'

import { LeaderLockService } from './leader-lock.service'

// Room for a run that sends many emails; a replica that dies holds the lock for this long at most
const LOCK_SECONDS = 300

// Every minute, on one replica: the emails of invitations that still wait in their outbox, because the job the api queued was lost (the
// queue was down) or the worker that took it died. The job the api queues delivers the usual case within seconds.
@Injectable()
export class InvitationEmailScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly delivery: InvitationEmailDelivery,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(InvitationEmailScheduler.name)
  }

  @Cron(Schedules.DELIVER_INVITATION_EMAILS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.DELIVER_INVITATION_EMAILS, LOCK_SECONDS, async () => {
        const sent = await this.delivery.sweep()
        if (sent > 0) this.logger.info({ sent }, 'invitation emails left in the outbox were sent')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next minute tries again
      this.logger.error({ errorName: errorName(error) }, 'the sweep of invitation emails failed')
    }
  }
}
