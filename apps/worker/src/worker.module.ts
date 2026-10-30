import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { EmailPlatformModule, HttpPlatformModule, QueuesPlatformModule } from '@platform/core/http'
import {
  ConversationsService,
  MESSAGING_WINDOW_POLICIES,
  type MessagingWindowPolicySource,
  MessagingWindowService,
  OutboundQueue
} from '@platform/core/messaging'
import { PluginRegistry, PluginsModule } from '@platform/plugins/runtime'

import { WorkerReadinessModule } from './health/worker-readiness.module'
import { InboundModule } from './inbound/inbound.module'
import { MessageChangeSender } from './outbound/message-change-sender.service'
import { MessageChangeStatusWriter } from './outbound/message-change-status.writer'
import { MessageStatusWriter } from './outbound/message-status.writer'
import { OutboundSender } from './outbound/outbound-sender.service'
import { ReactionSender } from './outbound/reaction-sender.service'
import { ReactionStatusWriter } from './outbound/reaction-status.writer'
import { ReadReceiptSender } from './outbound/read-receipt-sender.service'
import { TypingSender } from './outbound/typing-sender.service'
import { EmailProcessor } from './processors/email.processor'
import { OutboundProcessor } from './processors/outbound.processor'
import { ProcessorSupport } from './processors/processor-support'
import { ChannelHealthScheduler } from './schedulers/channel-health.scheduler'
import { DeletedMessagePurgeScheduler } from './schedulers/deleted-message-purge.scheduler'
import { LeaderLockService } from './schedulers/leader-lock.service'
import { OutboundRequeueScheduler } from './schedulers/outbound-requeue.scheduler'

// ScheduleModule is imported only here: the api never runs crons
@Module({
  imports: [
    HttpPlatformModule,
    QueuesPlatformModule,
    EmailPlatformModule,
    ChannelConnectionsLibModule,
    PluginsModule.forRoot(),
    ScheduleModule.forRoot(),
    WorkerReadinessModule,
    InboundModule
  ],
  providers: [
    ProcessorSupport,
    LeaderLockService,
    OutboundQueue,
    ConversationsService,
    MessagingWindowService,
    {
      provide: MESSAGING_WINDOW_POLICIES,
      // As in the api: the plugin owns its policy, and a channel with none has no window
      useFactory: (registry: PluginRegistry): MessagingWindowPolicySource => ({
        policyFor: channelId => registry.find(channelId)?.messagingWindow ?? null
      }),
      inject: [PluginRegistry]
    },
    MessageStatusWriter,
    OutboundSender,
    ReactionStatusWriter,
    ReactionSender,
    MessageChangeStatusWriter,
    MessageChangeSender,
    ReadReceiptSender,
    TypingSender,
    OutboundProcessor,
    EmailProcessor,
    ChannelHealthScheduler,
    OutboundRequeueScheduler,
    DeletedMessagePurgeScheduler
  ]
})
export class WorkerModule {}
