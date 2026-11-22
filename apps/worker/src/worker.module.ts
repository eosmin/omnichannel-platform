import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { RemoteChannelsLibModule } from '@platform/channels/remote'
import { AuditModule } from '@platform/core/audit-module'
import { LedgerModule } from '@platform/core/finance-ledger'
import {
  CryptoPlatformModule,
  DigestPlatformModule,
  EmailPlatformModule,
  HttpPlatformModule,
  isRequireContextOn,
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
import { DsrWorkerModule } from './compliance/dsr.module'
import { ExportsModule } from './exports/exports.module'
import { WorkerReadinessModule } from './health/worker-readiness.module'
import { WORKER_RLS_CONTEXT_ON, WorkerRoleCheck } from './health/worker-role.check'
import { InboundModule } from './inbound/inbound.module'
import { InvitationEmailDelivery } from './invitations/invitation-email-delivery.service'
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
import { RetentionWorkerModule } from './retention/retention.module'
import { AnalyticsRollupScheduler } from './schedulers/analytics-rollup.scheduler'
import { AuditColdExportScheduler } from './schedulers/audit-cold-export.scheduler'
import { AutoArchiveScheduler } from './schedulers/auto-archive.scheduler'
import { BenefitCloseScheduler } from './schedulers/benefit-close.scheduler'
import { BulkLabelsScheduler } from './schedulers/bulk-labels.scheduler'
import { ChannelHealthScheduler } from './schedulers/channel-health.scheduler'
import { DeletedMessagePurgeScheduler } from './schedulers/deleted-message-purge.scheduler'
import { EmailDigestScheduler } from './schedulers/email-digest.scheduler'
import { ExistingPicturesScheduler } from './schedulers/existing-pictures.scheduler'
import { ExpiredExportsScheduler } from './schedulers/expired-exports.scheduler'
import { FinanceChainScheduler } from './schedulers/finance-chain.scheduler'
import { FinanceReconcileScheduler } from './schedulers/finance-reconcile.scheduler'
import { InventoryReconcileScheduler } from './schedulers/inventory-reconcile.scheduler'
import { InvitationEmailScheduler } from './schedulers/invitation-email.scheduler'
import { LeaderLockService } from './schedulers/leader-lock.service'
import { OrphanMediaScheduler } from './schedulers/orphan-media.scheduler'
import { OutboundRequeueScheduler } from './schedulers/outbound-requeue.scheduler'
import { PickupEvaluateScheduler } from './schedulers/pickup-evaluate.scheduler'
import { PlatformCleanupScheduler } from './schedulers/platform-cleanup.scheduler'
import { RemittanceCheckScheduler } from './schedulers/remittance-check.scheduler'
import { ReportDispatchScheduler } from './schedulers/report-dispatch.scheduler'
import { RetentionScheduler } from './schedulers/retention.scheduler'
import { ShipmentPollScheduler } from './schedulers/shipment-poll.scheduler'
import { SnoozeWakeScheduler } from './schedulers/snooze-wake.scheduler'
import { TokenExpiryScheduler } from './schedulers/token-expiry.scheduler'
import { ShippingWorkerModule } from './shipping/shipping.module'
import { WebhooksWorkerModule } from './webhooks/webhooks.module'

// ScheduleModule is imported only here: the api never runs crons
@Module({
  imports: [
    HttpPlatformModule.forRoot({ redactedKeys: officialRedactedKeys() }),
    AuditModule,
    QueuesPlatformModule,
    EmailPlatformModule,
    CryptoPlatformModule,
    DigestPlatformModule,
    ChannelConnectionsLibModule,
    RemoteChannelsLibModule,
    PluginsModule.forRoot(),
    ScheduleModule.forRoot(),
    WorkerReadinessModule,
    InboundModule,
    MediaModule,
    ExportsModule,
    NotificationsModule,
    AnalyticsModule,
    CarriersWorkerModule,
    WebhooksWorkerModule,
    // The cleanup of the bulk labels is run by the scheduler below
    ShippingWorkerModule,
    // The platform cleanup is run by its scheduler below; the processors of the heavy and exports queues run the rest
    RetentionWorkerModule,
    // The public data request flow: the intake job of the heavy queue (Step 7.2-H1)
    DsrWorkerModule,
    // The posting service of the books (TDD_18 §6.1): the processors of Step 4B.6 post through it; nothing else writes the journal
    LedgerModule
  ],
  providers: [
    WorkerRoleCheck,
    { provide: WORKER_RLS_CONTEXT_ON, useFactory: isRequireContextOn },
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
    InvitationEmailDelivery,
    InvitationEmailScheduler,
    CarrierEventsProcessor,
    ChannelHealthScheduler,
    TokenExpiryScheduler,
    OutboundRequeueScheduler,
    DeletedMessagePurgeScheduler,
    OrphanMediaScheduler,
    ExistingPicturesScheduler,
    ExpiredExportsScheduler,
    EmailDigestScheduler,
    ReportDispatchScheduler,
    SnoozeWakeScheduler,
    AutoArchiveScheduler,
    InventoryReconcileScheduler,
    FinanceReconcileScheduler,
    FinanceChainScheduler,
    AnalyticsRollupScheduler,
    ShipmentPollScheduler,
    RemittanceCheckScheduler,
    BenefitCloseScheduler,
    PickupEvaluateScheduler,
    BulkLabelsScheduler,
    RetentionScheduler,
    PlatformCleanupScheduler,
    AuditColdExportScheduler
  ]
})
export class WorkerModule {}
