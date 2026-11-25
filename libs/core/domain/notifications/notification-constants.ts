import { DigestFrequency } from '../status-enums'

import { hourIn } from './quiet-hours'

export const NotificationTypes = {
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_MENTIONED: 'conversation.mentioned',
  CONVERSATION_UNASSIGNED_QUEUE: 'conversation.unassigned_queue',
  CONVERSATION_SNOOZE_EXPIRED: 'conversation.snooze_expired',
  CONVERSATION_REOPENED: 'conversation.reopened',

  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_FAILED: 'message.failed',

  ORDER_CREATED: 'order.created',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_PAYMENT_FAILED: 'order.payment_failed',
  ORDER_MESSAGE_NOT_SENT: 'order.message_not_sent',
  ORDER_PRICE_APPROVAL_REQUESTED: 'order.price_approval_requested',
  ORDER_PRICE_OVERRIDDEN: 'order.price_overridden',
  // The packing note changed after the order was confirmed: the warehouse reads it before it packs
  ORDER_PACKING_NOTE_CHANGED: 'order.packing_note_changed',

  INVENTORY_LOW: 'inventory.low',
  TRANSFER_DISPATCHED: 'transfer.dispatched',
  COUNT_AWAITING_APPLY: 'count.awaiting_apply',

  PICKUP_CUTOFF_APPROACHING: 'pickup.cutoff_approaching',
  PICKUP_MANUAL_REQUIRED: 'pickup.manual_required',
  SHIPMENT_CANCEL_FAILED: 'shipment.cancel_failed',
  SHIPMENT_REQUIRES_REVIEW: 'shipment.requires_review',
  SHIPMENT_FAILED_ATTEMPT: 'shipment.failed_attempt',
  CARRIER_STATUS_UNMAPPED: 'carrier.status_unmapped',
  BULK_LABELS_READY: 'bulk_labels.ready',
  RETURN_AWAITING_RECEIPT: 'return.awaiting_receipt',
  REMITTANCE_OVERDUE: 'remittance.overdue',
  // The balance of prepaid guides of a carrier connection and its refund benefit (TDD_17 §4.18)
  CARRIER_GUIDE_BALANCE_LOW: 'carrier.guide_balance_low',
  CARRIER_GUIDE_BALANCE_EMPTY: 'carrier.guide_balance_empty',
  CARRIER_BENEFIT_AT_RISK: 'carrier.benefit_at_risk',
  CARRIER_BENEFIT_LOST: 'carrier.benefit_lost',

  MEMBER_JOINED: 'member.joined',
  INVITATION_ACCEPTED: 'invitation.accepted',

  CHANNEL_DISCONNECTED: 'channel.disconnected',
  CHANNEL_TOKEN_EXPIRING: 'channel.token_expiring',
  WEBHOOK_AUTO_DISABLED: 'webhook.auto_disabled',
  PLUGIN_ERROR: 'plugin.error',
  // An automatic entry of the books failed and a person must fix its cause (TDD_18 §6.1)
  FINANCE_POSTING_FAILED: 'finance.posting_failed',
  // A prepaid order was cancelled after its payment was booked: the customer's advance is owed and nothing pays it back by itself (TDD_18 §4.2 E1)
  FINANCE_ADVANCE_OWED: 'finance.advance_owed',
  // The weekly check found the journal altered: nobody can close a month until the chain verifies again (TDD_18 §11)
  FINANCE_CHAIN_BROKEN: 'finance.chain_broken',
  // A fiscal document was refused, or ran out of attempts, and a person must act on it (TDD_18 §8.3, Step 4B.7b-2)
  FISCAL_DOCUMENT_REJECTED: 'fiscal.document_rejected',
  FISCAL_DOCUMENT_STUCK: 'fiscal.document_stuck',
  // The window (24 hours) to correct and send again a document the authority refused is closing or over (D14)
  FISCAL_RETRANSMIT_DEADLINE: 'fiscal.retransmit_deadline',
  // The files of an accepted document could not be given to its receiver and a person must (Normativa DTE v2.0, section 11)
  FISCAL_DELIVERY_NOT_SENT: 'fiscal.delivery_not_sent',
  // A sale document disagrees with its entry of the books: only a person can say which one is right (TDD_18 §11, Step 4B.8b-2b)
  FISCAL_ENTRY_MISMATCH: 'fiscal.entry_mismatch',
  // A contingency of the issuer: opened by the lifecycle, its event not accepted, its window closing (Step 4B.7c-7)
  FISCAL_CONTINGENCY_OPENED: 'fiscal.contingency_opened',
  FISCAL_CONTINGENCY_REPORT_FAILED: 'fiscal.contingency_report_failed',
  FISCAL_CONTINGENCY_WINDOW_CLOSING: 'fiscal.contingency_window_closing',
  EXPORT_READY: 'export.ready',
  EXPORT_FAILED: 'export.failed',
  MEDIA_INFECTED: 'media.infected',
  MEDIA_UNSCANNABLE: 'media.unscannable',
  DSR_DEADLINE_APPROACHING: 'dsr.deadline_approaching',
  DSR_MANUAL_REVIEW: 'dsr.manual_review',
  // The closing notice of a data request never reached the person (Step 7.2-H2b-2): someone must tell them another way
  DSR_NOTICE_FAILED: 'dsr.notice_failed'
} as const

export type NotificationType = (typeof NotificationTypes)[keyof typeof NotificationTypes]

export const NotificationSeverity = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error'
} as const

export type NotificationSeverityType =
  (typeof NotificationSeverity)[keyof typeof NotificationSeverity]

// The i18n key for a notification is derived from its type: one rule, no table to maintain.
//   'conversation.assigned' -> 'notifications.conversation.assigned' (+ '.title' / '.body')
export const notificationMessageKey = (type: NotificationType): string => `notifications.${type}`

// Realtime payload delivered to the browser (RealtimeEventMap[NOTIFICATION], TDD_02 §2).
export interface NotificationRealtimePayload {
  id: string
  type: NotificationType
  severity: NotificationSeverityType
  messageKey: string
  params: Record<string, string | number>
  actionPath: string | null
  sound: boolean
  createdAt: string
}

// The tabs of the notification center (TDD_06 §8)
export const NotificationFilters = {
  ALL: 'all',
  UNREAD: 'unread',
  MENTIONS: 'mentions'
} as const

export type NotificationFilter = (typeof NotificationFilters)[keyof typeof NotificationFilters]

export const NotificationLimits = {
  // Ids a single "mark as read" may name
  MARK_READ_MAX_IDS: 100,
  // The badge on the bell stops counting here and shows "99+" (TDD_06 §8)
  BADGE_CAP: 99,
  // An unread notification stops holding back a new one of its kind after this long: a person who
  // never clears the bell must still hear of what happens next
  DEDUP_WINDOW_MS: 60 * 60 * 1000
} as const

// What a user who never opened the preferences gets for the settings that are theirs (the columns of
// UserNotificationSettings carry the same values as their defaults)
export const NotificationSettingsDefaults = {
  quietHoursEnabled: false,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  quietHoursFollowStore: false,
  timezone: 'America/El_Salvador',
  digestFrequency: DigestFrequency.HOURLY,
  crossStoreEnabled: true,
  crossStoreSupervisorOnly: false
} as const

// The email digest (TDD_06 §6.4)
export const DigestLimits = {
  // The hour, on the clock of the person, at which the daily digest goes out (TDD_07 §4: 08:10)
  DAILY_LOCAL_HOUR: 8,
  // Rows one email lists; the rest is counted ("and 12 more") and read in the app
  MAX_ITEMS: 20,
  // A row waiting for email longer than this is dropped unsent: the person had it switched off, or the
  // digest could not run, and a morning email about last week is noise
  MAX_AGE_HOURS: 48,
  // People one scan of the scheduler queues; a full scan is logged and the next hour takes the rest
  SCAN_BATCH: 500
} as const

// Whether the daily digest of a person is due at this moment: their clock reads the digest hour
export function isDailyDigestHour(timezone: string, at: Date): boolean {
  return hourIn(timezone, at) === DigestLimits.DAILY_LOCAL_HOUR
}

// What a notification points to (`resourceType`) and the key of the name it carries (`params.customer`). The clearing of an erased customer
// (Step 7.2-C) finds the notifications that name them by both, so the emitters and that sweep read the same constants
export const NotificationResourceTypes = {
  CONVERSATION: 'conversation',
  MESSAGE: 'message'
} as const
export const NotificationParamKeys = { CUSTOMER: 'customer', MEMBER: 'member' } as const
