import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { AuditModule } from '@platform/core/audit-module'
import {
  DigestPlatformModule,
  EmailPlatformModule,
  HttpPlatformModule,
  QueuesPlatformModule
} from '@platform/core/http'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import {
  ConversationsService,
  MESSAGING_WINDOW_POLICIES,
  type MessagingWindowPolicySource,
  MessagingWindowService,
  OutboundQueue
} from '@platform/core/messaging'
import { officialRedactedKeys, PluginRegistry, PluginsModule } from '@platform/plugins/runtime'

import { AnalyticsModule } from './analytics/analytics.module'
import { CarriersWorkerModule } from './carriers/carriers.module'
import { ExportsModule } from './exports/exports.module'
import { WorkerReadinessModule } from './health/worker-readiness.module'
import { InboundModule } from './inbound/inbound.module'
import { MediaModule } from './media/media.module'
import { NotificationsModule } from './notifications/notifications.module'
import { MessageChangeSender } from './outbound/message-change-sender.service'
import { MessageChangeStatusWriter } from './outbound/message-change-status.writer'
import { MessageStatusWriter } from './outbound/message-status.writer'
import { OutboundSender } from './outbound/outbound-sender.service'
import { ReactionSender } from './outbound/reaction-sender.service'
import { ReactionStatusWriter } from './outbound/reaction-status.writer'
import { ReadReceiptSender } from './outbound/read-receipt-sender.service'
import { TypingSender } from './outbound/typing-sender.service'
import { CarrierEventsProcessor } from './processors/carrier-events.processor'
import { EmailProcessor } from './processors/email.processor'
import { OutboundProcessor } from './processors/outbound.processor'
import { ProcessorSupport } from './processors/processor-support'
import { AutoArchiveScheduler } from './schedulers/auto-archive.scheduler'
import { BulkLabelsScheduler } from './schedulers/bulk-labels.scheduler'
import { ChannelHealthScheduler } from './schedulers/channel-health.scheduler'
import { DeletedMessagePurgeScheduler } from './schedulers/deleted-message-purge.scheduler'
import { EmailDigestScheduler } from './schedulers/email-digest.scheduler'
import { ExpiredExportsScheduler } from './schedulers/expired-exports.scheduler'
import { InventoryReconcileScheduler } from './schedulers/inventory-reconcile.scheduler'
import { LeaderLockService } from './schedulers/leader-lock.service'
import { OrphanMediaScheduler } from './schedulers/orphan-media.scheduler'
import { OutboundRequeueScheduler } from './schedulers/outbound-requeue.scheduler'
import { RemittanceCheckScheduler } from './schedulers/remittance-check.scheduler'
import { ShipmentPollScheduler } from './schedulers/shipment-poll.scheduler'
import { SnoozeWakeScheduler } from './schedulers/snooze-wake.scheduler'
import { TokenExpiryScheduler } from './schedulers/token-expiry.scheduler'
import { ShippingWorkerModule } from './shipping/shipping.module'

// ScheduleModule is imported only here: the api never runs crons
@Module({
  imports: [
    HttpPlatformModule.forRoot({ redactedKeys: officialRedactedKeys() }),
    AuditModule,
    QueuesPlatformModule,
    EmailPlatformModule,
    DigestPlatformModule,
    ChannelConnectionsLibModule,
    PluginsModule.forRoot(),
    ScheduleModule.forRoot(),
    WorkerReadinessModule,
    InboundModule,
    MediaModule,
    ExportsModule,
    NotificationsModule,
    AnalyticsModule,
    CarriersWorkerModule,
    // The cleanup of the bulk labels is run by the scheduler below
    ShippingWorkerModule
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
    MagicLinkIssuer,
    EmailProcessor,
    CarrierEventsProcessor,
    ChannelHealthScheduler,
    TokenExpiryScheduler,
    OutboundRequeueScheduler,
    DeletedMessagePurgeScheduler,
    OrphanMediaScheduler,
    ExpiredExportsScheduler,
    EmailDigestScheduler,
    SnoozeWakeScheduler,
    AutoArchiveScheduler,
    InventoryReconcileScheduler,
    ShipmentPollScheduler,
    RemittanceCheckScheduler,
    BulkLabelsScheduler
  ]
})
export class WorkerModule {}
