import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { ChannelHealthService, RemoteChannelHealthService } from '@platform/channels/connections'
import { LockNames, Schedules } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import { LeaderLockService } from './leader-lock.service'

// A little under the interval of the schedule, so that a replica that died holding the lock does not
// skip the next round
const LOCK_SECONDS = 240

// Every few minutes the worker asks each connection's plugin whether it is well (TDD_10 §10). Of the
// replicas, one does it.
@Injectable()
export class ChannelHealthScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly health: ChannelHealthService,
    private readonly remoteHealth: RemoteChannelHealthService,
    private readonly registry: PluginRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ChannelHealthScheduler.name)
  }

  @Cron(Schedules.CHECK_CHANNEL_HEALTH)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CHECK_CHANNEL_HEALTH, LOCK_SECONDS, async () => {
        // The remote plugins have a round of their own (their own lock and counter, TDD_10 §6.7.7)
        const { checked, unhealthy } = await this.health.checkAll(
          id => this.registry.find(id),
          undefined,
          id => this.registry.isRemote(id)
        )
        this.logger.info({ checked, unhealthy }, 'channel health checked')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next round tries again
      this.logger.error({ err: error }, 'the channel health round failed')
    }
  }

  @Cron(Schedules.CHECK_REMOTE_CHANNEL_HEALTH)
  async runRemote(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CHECK_REMOTE_CHANNEL_HEALTH, LOCK_SECONDS, async () => {
        const { checked, unhealthy } = await this.remoteHealth.checkAll()
        this.logger.info({ checked, unhealthy }, 'remote channel health checked')
      })
    } catch (error) {
      this.logger.error({ err: error }, 'the remote channel health round failed')
    }
  }
}
