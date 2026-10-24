import type { AnalyticsEventName } from '@platform/core/analytics'
import type { ChannelType, DigestFrequency } from '@platform/core/domain'
import type { EventName } from '@platform/core/events'

import { AuditAction, type AuditActionType } from '../audit'

import type { JobName, QueueName } from './queue-names'

// Every payload is a plain, JSON-serializable object and carries correlationId when it originates
// from a request (TDD_04 §1.3). The payloads of the channel-event and email jobs arrive with the
// plugin SDK (Step 2.5) and the email templates, because they use types those steps create.
export interface BaseJob {
  correlationId?: string
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
export const ExportTypes = {
  CONVERSATIONS: 'conversations',
  CUSTOMERS: 'customers',
  ORDERS: 'orders',
  AUDIT_LOG: 'audit_log',
  ANALYTICS: 'analytics',
  MEDIA_ZIP: 'media_zip'
} as const
export type ExportType = (typeof ExportTypes)[keyof typeof ExportTypes]

export const ExportFormats = { CSV: 'csv', EXCEL: 'excel', PDF: 'pdf', ZIP: 'zip' } as const
export type ExportFormat = (typeof ExportFormats)[keyof typeof ExportFormats]

// Export.status (TDD_01 §4). Exports expire after 14 days (DataRetentionPolicies.EXPORTS).
export const ExportStatus = {
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed',
  EXPIRED: 'expired'
} as const
export type ExportStatusType = (typeof ExportStatus)[keyof typeof ExportStatus]

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
export interface FetchInboundMediaJob extends BaseJob {
  messageId: string
  storeId: string
  pluginId: ChannelType
  connectionId: string
  mediaRef: string
  contentType: string
  filename: string | null
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
