import type { AnalyticsEventName } from '@platform/core/analytics'
import type { ChannelId, DigestFrequency, OriginMediaSlot } from '@platform/core/domain'
import type { EventName } from '@platform/core/events'
import { ExportTypes, type ExportType } from '@platform/core/exports'
import type { Locale } from '@platform/core/i18n'

import { AuditAction, type AuditActionType } from '../audit'

import type { EmailTemplate } from './email-templates'
import type { JobName, QueueName } from './queue-names'

// Every payload is a plain, JSON-serializable object and carries correlationId when it originates
// from a request (TDD_04 §1.3). The payload of the channel-event job arrives with the plugin SDK
// (Step 2.5), because it uses a type that step creates.
export interface BaseJob {
  correlationId?: string
}

// email: one job type, the template decides content and subject
export interface SendEmailJob extends BaseJob {
  template: EmailTemplate
  to: string | string[]
  locale: Locale
  data: Record<string, unknown> // Validated against the template's schema when it is rendered
  attachments?: { filename: string; contentBase64: string; contentType: string }[]
  tags: { storeId?: string; template: EmailTemplate } // Echoed back by the Resend webhook (TDD_07 §5.4)
}

// webhooks
export interface TriggerWebhookJob extends BaseJob {
  webhookId: string // Tenant Webhook row
  storeId: string
  event: EventName
  payload: Record<string, unknown>
}

export interface TriggerPluginWebhookJob extends BaseJob {
  pluginInstallationId: string // Endpoint + secret come from the manifest (TDD_10 §6.5)
  storeId: string
  event: EventName
  payload: Record<string, unknown>
}

// notifications
export interface SendWebPushJob extends BaseJob {
  userId: string
  notificationId: string
}
export interface QueueEmailDigestJob extends BaseJob {
  userId: string
  notificationId: string
}
export interface SendEmailDigestJob extends BaseJob {
  userId: string
  frequency: DigestFrequency
}

// analytics
export interface TrackAnalyticsJob extends BaseJob {
  event: AnalyticsEventName // TDD_11 §7.1
  storeId: string
  data: Record<string, unknown>
  timestamp: string
}
export interface RollupJob extends BaseJob {
  storeId: string
  periodStart: string
  periodEnd: string
}

// exports
// The kinds, formats and states live in the domain: the web page of the exports center reads them
// and may not import from the platform layer. Re-exported so the api and the worker keep one path.
export {
  ExportFormats,
  ExportStatus,
  ExportTypes,
  type ExportFormat,
  type ExportStatusType,
  type ExportType
} from '@platform/core/exports'

// Maps every ExportType to the AuditAction written when the file is generated (TDD_07 §6.6).
export const ExportAuditActions: Record<ExportType, AuditActionType> = {
  [ExportTypes.CONVERSATIONS]: AuditAction.CONVERSATION_EXPORTED,
  [ExportTypes.CUSTOMERS]: AuditAction.CUSTOMER_EXPORTED,
  [ExportTypes.ORDERS]: AuditAction.ORDER_EXPORTED,
  [ExportTypes.AUDIT_LOG]: AuditAction.AUDIT_LOG_EXPORTED,
  [ExportTypes.ANALYTICS]: AuditAction.ANALYTICS_EXPORTED,
  [ExportTypes.MEDIA_ZIP]: AuditAction.MEDIA_BULK_DOWNLOADED
}

export interface GenerateExportJob extends BaseJob {
  exportId: string // Everything else is on the Export row
}
export interface GenerateScheduledReportJob extends BaseJob {
  reportId: string
}
export interface DsrExportJob extends BaseJob {
  requestId: string
}
export interface DsrEraseJob extends BaseJob {
  requestId: string
}
export interface ExportAuditLogsJob extends BaseJob {
  before: string
}

// heavy processing
export interface ScanFileJob extends BaseJob {
  mediaId: string
}
export interface ProcessImageJob extends BaseJob {
  mediaId: string
}
// The picture of an ad, fetched by the core from the link the provider sent; the link is read from
// the origin row when the job runs, never carried in the job
export interface FetchOriginMediaJob extends BaseJob {
  storeId: string
  originId: string
  slot: OriginMediaSlot
}
export interface FetchInboundMediaJob extends BaseJob {
  messageId: string
  // Place of the file in the message: with the message it names the media, so a retry is one file
  index: number
  storeId: string
  pluginId: ChannelId
  connectionId: string
  mediaRef: string
  contentType: string
  filename: string | null
}
// inbound: the profile of one customer identity, read again from the database when the job runs
export interface FetchCustomerProfileJob extends BaseJob {
  storeId: string
  identityId: string
  // The ChannelConnection row that delivered the message: the one whose token reads the profile
  connectionRowId: string
}
// outbound: the message is read again by id, so a retry sends what is stored now and not a copy
export interface SendOutboundMessageJob extends BaseJob {
  storeId: string
  messageId: string
}
// outbound: the reaction of one agent to one message. The row is read again when the job runs (no row
// is a reaction taken back); `version` is when the reaction was set, so that a job of an earlier
// emoji can tell that a newer one is on its way and leaves it alone.
export interface SendOutboundReactionJob extends BaseJob {
  storeId: string
  messageId: string
  userId: string
  version: number
}
// An agent's edit or deletion of a message of ours. `version` is the `version` of the message when the
// agent asked: it only gives each request its own job id.
export interface SendOutboundEditJob extends BaseJob {
  storeId: string
  messageId: string
  version: number
}
export interface SendOutboundDeleteJob extends BaseJob {
  storeId: string
  messageId: string
  version: number
}
// The agent read the conversation up to `messageId`, the latest message of the customer that has an id at
// the channel. Nothing is stored about it: the job is best effort.
export interface SendOutboundReadReceiptJob extends BaseJob {
  storeId: string
  conversationId: string
  messageId: string
}
// An agent started (`active`) or stopped typing in the conversation. Nothing is stored: the job is best
// effort and never retried, since a typing indicator that arrives late shows the wrong thing.
export interface SendOutboundTypingJob extends BaseJob {
  storeId: string
  conversationId: string
  active: boolean
  // When the agent did it (epoch ms): the worker drops a job that went stale or that a newer one overtook
  at: number
}
export interface EnforceRetentionJob extends BaseJob {
  storeId: string
}

// dead letter: a copy kept for triage; the failed job itself stays in its original queue
export interface DeadLetterJob {
  originalQueue: QueueName
  originalJobName: JobName
  originalJobId: string | undefined
  originalData: unknown
  error: string
  failedAt: string
}
