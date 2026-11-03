import { Module } from '@nestjs/common'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { QueuesPlatformModule } from '@platform/core/http'
import {
  AwayReplyService,
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  CustomerProfileService,
  InboundMessageChangesService,
  InboundMessageService,
  InboundMessageTargets,
  MESSAGING_WINDOW_POLICIES,
  MessageReactionsService,
  type MessagingWindowPolicySource,
  MessagingWindowService,
  OutboundQueue,
  RoutingService
} from '@platform/core/messaging'
import { PluginRegistry, PluginsModule } from '@platform/plugins/runtime'

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
    MessagingWindowService,
    {
      provide: MESSAGING_WINDOW_POLICIES,
      // As in the api: the plugin owns its policy, and a channel with none has no window
      useFactory: (registry: PluginRegistry): MessagingWindowPolicySource => ({
        policyFor: channelId => registry.find(channelId)?.messagingWindow ?? null
      }),
      inject: [PluginRegistry]
    },
    OutboundQueue,
    AwayReplyService,
    InboundMessageService,
    InboundMessageTargets,
    InboundMessageChangesService,
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
