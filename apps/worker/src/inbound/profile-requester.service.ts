import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import {
  ChannelConnectionResolver,
  needsProfileRead,
  profileJobId,
  parseChannelIdentity
} from '@platform/core/messaging'
import { type FetchCustomerProfileJob, JobNames, QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

// Decides, once a customer message is stored, whether the channel should be asked for the name and photo
// of the person: only a plugin that can answer, and only a profile never read or gone stale. A failure
// here is logged and swallowed: the message is already stored and a retry of its job would only find it.
@Injectable()
export class ProfileRequester {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly connections: ChannelConnectionResolver,
    @InjectQueue(QueueNames.CUSTOMER_PROFILES)
    private readonly queue: Queue<FetchCustomerProfileJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ProfileRequester.name)
  }

  async request(pluginId: string, connectionId: string, channelIdentity: string): Promise<void> {
    try {
      if (this.registry.find(pluginId)?.fetchProfile === undefined) return
      const parsed = parseChannelIdentity(pluginId, channelIdentity, { fromChannel: true })
      if (parsed === null) return
      const now = new Date()
      // Two lookups by unique index. The store is the connection's, never one that the event names.
      const connection = await this.connections.resolve(pluginId, connectionId)
      if (connection === null || !connection.active) return
      const identity = await this.prisma.client.customerIdentity.findFirst({
        where: {
          storeId: connection.storeId,
          channelType: pluginId,
          channelIdentity: parsed.identity
        },
        select: { id: true, profileFetchedAt: true, profileRetryAfter: true }
      })
      if (identity === null || !needsProfileRead(identity, now)) return
      await this.queue.add(
        JobNames.FETCH_CUSTOMER_PROFILE,
        { storeId: connection.storeId, identityId: identity.id, connectionRowId: connection.id },
        { jobId: profileJobId(identity.id, identity, now) }
      )
    } catch (error) {
      this.logger.warn({ pluginId, errorName: errorName(error) }, 'queueing a profile read failed')
    }
  }
}
