import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { EmailPlatformModule, HttpPlatformModule, QueuesPlatformModule } from '@platform/core/http'
import { OutboundQueue } from '@platform/core/messaging'
import { PluginsModule } from '@platform/plugins/runtime'

import { WorkerReadinessModule } from './health/worker-readiness.module'
import { InboundModule } from './inbound/inbound.module'
import { MessageStatusWriter } from './outbound/message-status.writer'
import { OutboundSender } from './outbound/outbound-sender.service'
import { ReactionSender } from './outbound/reaction-sender.service'
import { ReactionStatusWriter } from './outbound/reaction-status.writer'
import { EmailProcessor } from './processors/email.processor'
import { OutboundProcessor } from './processors/outbound.processor'
import { ProcessorSupport } from './processors/processor-support'
import { ChannelHealthScheduler } from './schedulers/channel-health.scheduler'
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
    MessageStatusWriter,
    OutboundSender,
    ReactionStatusWriter,
    ReactionSender,
    OutboundProcessor,
    EmailProcessor,
    ChannelHealthScheduler,
    OutboundRequeueScheduler
  ]
})
export class WorkerModule {}
