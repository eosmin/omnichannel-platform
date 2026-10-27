import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { EmailPlatformModule, HttpPlatformModule, QueuesPlatformModule } from '@platform/core/http'
import { OutboundQueue } from '@platform/core/messaging'
import { PluginsModule } from '@platform/plugins/runtime'

import { WorkerReadinessModule } from './health/worker-readiness.module'
import { InboundModule } from './inbound/inbound.module'
import { OutboundModule } from './outbound/outbound.module'
import { EmailProcessor } from './processors/email.processor'
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
    InboundModule,
    OutboundModule
  ],
  providers: [
    ProcessorSupport,
    LeaderLockService,
    OutboundQueue,
    EmailProcessor,
    ChannelHealthScheduler,
    OutboundRequeueScheduler
  ]
})
export class WorkerModule {}
