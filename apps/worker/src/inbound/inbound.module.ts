import { Module } from '@nestjs/common'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { QueuesPlatformModule } from '@platform/core/http'
import {
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  CustomerProfileService,
  InboundMessageService,
  MessageReactionsService,
  RoutingService
} from '@platform/core/messaging'
import { PluginsModule } from '@platform/plugins/runtime'

import { ChannelReceipts } from '../outbound/channel-receipts.service'
import { MessageStatusWriter } from '../outbound/message-status.writer'
import { CustomerProfileProcessor } from '../processors/customer-profile.processor'
import { InboundProcessor } from '../processors/inbound.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { ProfileFetcher } from './profile-fetcher.service'
import { ProfileRequester } from './profile-requester.service'

// The database, the event bus and the logger come from the platform module of the worker. The queue
// of the heavy jobs is where the media of a message is sent to be fetched.
@Module({
  imports: [QueuesPlatformModule, ChannelConnectionsLibModule, PluginsModule.forRoot()],
  providers: [
    ProcessorSupport,
    ChannelConnectionResolver,
    CustomerIdentityService,
    CustomerProfileService,
    ConversationsService,
    RoutingService,
    InboundMessageService,
    MessageReactionsService,
    MessageStatusWriter,
    ChannelReceipts,
    ProfileRequester,
    ProfileFetcher,
    InboundProcessor,
    CustomerProfileProcessor
  ]
})
export class InboundModule {}
