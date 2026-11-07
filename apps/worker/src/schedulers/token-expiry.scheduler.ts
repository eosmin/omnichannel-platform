import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { ChannelTokenExpiryService } from '@platform/channels/connections'
import { TokenExpiryLimits } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import { LeaderLockService } from './leader-lock.service'

// A little over the budget of a round, so that a replica that died holding the lock does not skip the next
// one for long
const LOCK_SECONDS = TokenExpiryLimits.ROUND_BUDGET_MS / 1000 + 60

// Every few hours the worker asks the provider about the token of each connection that is due (at most once a
// day each, and a capped number of questions per round), and the people who set the channel up are told
// before a token stops. Of the replicas, one does it.
@Injectable()
export class TokenExpiryScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly tokens: ChannelTokenExpiryService,
    private readonly registry: PluginRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(TokenExpiryScheduler.name)
  }

  @Cron(Schedules.CHECK_TOKEN_EXPIRY)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CHECK_TOKEN_EXPIRY, LOCK_SECONDS, async () => {
        const { asked, written } = await this.tokens.runDue(id => this.registry.find(id))
        this.logger.info({ asked, written }, 'channel tokens checked')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next round tries again
      this.logger.error({ errorName: errorName(error) }, 'the channel token round failed')
    }
  }
}
