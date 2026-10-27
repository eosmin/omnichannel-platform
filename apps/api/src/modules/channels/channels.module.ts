import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { ChannelRegistryModule } from '../channel-registry'

import { ChannelWebhookController } from './channel-webhook.controller'

// The public door of the channels. The registry comes from the registry module and the inbound queue
// from the queues module.
@Module({
  imports: [ChannelRegistryModule, QueuesPlatformModule],
  controllers: [ChannelWebhookController]
})
export class ChannelsModule {}
