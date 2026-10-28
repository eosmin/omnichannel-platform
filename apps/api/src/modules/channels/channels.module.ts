import { Module } from '@nestjs/common'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { QueuesPlatformModule } from '@platform/core/http'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { ChannelConnectionsController } from './channel-connections.controller'
import { ChannelConnectionsService } from './channel-connections.service'
import { ChannelWebhookController } from './channel-webhook.controller'

// The public door of the channels (the webhook) and their management from Settings. The registry
// comes from the registry module, the inbound queue from the queues module and the cipher of the
// credentials from the crypto module.
@Module({
  imports: [
    ChannelRegistryModule,
    QueuesPlatformModule,
    ChannelConnectionsLibModule,
    TenancyModule
  ],
  controllers: [ChannelWebhookController, ChannelConnectionsController],
  providers: [ChannelConnectionsService],
  exports: [ChannelConnectionsService]
})
export class ChannelsModule {}
