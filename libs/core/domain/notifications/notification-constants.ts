import { DigestFrequency, NotificationChannel } from '../status-enums'

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

  MEMBER_JOINED: 'member.joined',
  INVITATION_ACCEPTED: 'invitation.accepted',

  CHANNEL_DISCONNECTED: 'channel.disconnected',
  CHANNEL_TOKEN_EXPIRING: 'channel.token_expiring',
  WEBHOOK_AUTO_DISABLED: 'webhook.auto_disabled',
  PLUGIN_ERROR: 'plugin.error',
  EXPORT_READY: 'export.ready',
  EXPORT_FAILED: 'export.failed',
  MEDIA_INFECTED: 'media.infected',
  MEDIA_UNSCANNABLE: 'media.unscannable',
  DSR_DEADLINE_APPROACHING: 'dsr.deadline_approaching',
  DSR_MANUAL_REVIEW: 'dsr.manual_review'
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

export interface NotificationDefault {
  severity: NotificationSeverityType
  channels: readonly NotificationChannel[]
}

const { IN_APP, PUSH, EMAIL, SOUND } = NotificationChannel
const { INFO, SUCCESS, WARNING, ERROR } = NotificationSeverity

// Channel rule (TDD_06 §6.1), how a default is chosen:
//   IN_APP always. PUSH when someone must act soon or it is time-sensitive, and for a customer who
//   writes (a message to its owner, a conversation nobody owns: owner, 2026-11-08). EMAIL when money or a
//   legal deadline is involved, or the person may be away from the app. SOUND for inbox events only.
// Default delivery matrix per type: complete, one entry per NotificationType. TDD_09 §9 renders
// exactly this matrix; the two must never disagree.
export const NotificationDefaults: Record<NotificationType, NotificationDefault> = {
  [NotificationTypes.CONVERSATION_ASSIGNED]: { severity: INFO, channels: [IN_APP, PUSH, SOUND] },
  [NotificationTypes.CONVERSATION_MENTIONED]: {
    severity: INFO,
    channels: [IN_APP, PUSH, EMAIL, SOUND]
  },
  [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE]: { severity: INFO, channels: [IN_APP, PUSH] },
  [NotificationTypes.CONVERSATION_SNOOZE_EXPIRED]: {
    severity: INFO,
    channels: [IN_APP, PUSH, SOUND]
  },
  [NotificationTypes.CONVERSATION_REOPENED]: { severity: INFO, channels: [IN_APP, PUSH] },
  [NotificationTypes.MESSAGE_RECEIVED]: { severity: INFO, channels: [IN_APP, PUSH, SOUND] },
  [NotificationTypes.MESSAGE_FAILED]: { severity: ERROR, channels: [IN_APP, PUSH] },
  [NotificationTypes.ORDER_CREATED]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.ORDER_STATUS_CHANGED]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.ORDER_PAYMENT_FAILED]: { severity: WARNING, channels: [IN_APP, PUSH, EMAIL] },
  [NotificationTypes.ORDER_MESSAGE_NOT_SENT]: { severity: WARNING, channels: [IN_APP, PUSH] },
  [NotificationTypes.ORDER_PRICE_APPROVAL_REQUESTED]: {
    severity: WARNING,
    channels: [IN_APP, PUSH]
  },
  [NotificationTypes.ORDER_PRICE_OVERRIDDEN]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.ORDER_PACKING_NOTE_CHANGED]: { severity: WARNING, channels: [IN_APP, PUSH] },
  [NotificationTypes.INVENTORY_LOW]: { severity: WARNING, channels: [IN_APP] },
  [NotificationTypes.TRANSFER_DISPATCHED]: { severity: INFO, channels: [IN_APP, PUSH] },
  [NotificationTypes.COUNT_AWAITING_APPLY]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.PICKUP_CUTOFF_APPROACHING]: { severity: WARNING, channels: [IN_APP, PUSH] },
  [NotificationTypes.PICKUP_MANUAL_REQUIRED]: { severity: WARNING, channels: [IN_APP, PUSH] },
  [NotificationTypes.SHIPMENT_CANCEL_FAILED]: {
    severity: WARNING,
    channels: [IN_APP, PUSH, EMAIL]
  },
  [NotificationTypes.SHIPMENT_REQUIRES_REVIEW]: {
    severity: WARNING,
    channels: [IN_APP, PUSH, EMAIL]
  },
  [NotificationTypes.SHIPMENT_FAILED_ATTEMPT]: { severity: INFO, channels: [IN_APP, PUSH] },
  [NotificationTypes.CARRIER_STATUS_UNMAPPED]: {
    severity: WARNING,
    channels: [IN_APP, PUSH, EMAIL]
  },
  [NotificationTypes.BULK_LABELS_READY]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.RETURN_AWAITING_RECEIPT]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.REMITTANCE_OVERDUE]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.MEMBER_JOINED]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.INVITATION_ACCEPTED]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.CHANNEL_DISCONNECTED]: { severity: ERROR, channels: [IN_APP, PUSH, EMAIL] },
  [NotificationTypes.CHANNEL_TOKEN_EXPIRING]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.WEBHOOK_AUTO_DISABLED]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.PLUGIN_ERROR]: { severity: ERROR, channels: [IN_APP] },
  [NotificationTypes.EXPORT_READY]: { severity: SUCCESS, channels: [IN_APP] },
  [NotificationTypes.EXPORT_FAILED]: { severity: ERROR, channels: [IN_APP] },
  [NotificationTypes.MEDIA_INFECTED]: { severity: WARNING, channels: [IN_APP, PUSH] },
  [NotificationTypes.MEDIA_UNSCANNABLE]: { severity: WARNING, channels: [IN_APP] },
  [NotificationTypes.DSR_DEADLINE_APPROACHING]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.DSR_MANUAL_REVIEW]: { severity: INFO, channels: [IN_APP, EMAIL] }
}

// How the preferences page groups the matrix (TDD_06 §9). A type that is not in a group is not
// configurable by the person: the org-level ones (data requests) never appear in it.
export const NotificationGroups = {
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  ORDERS: 'orders',
  INVENTORY: 'inventory',
  SHIPPING: 'shipping',
  TEAM: 'team',
  SYSTEM: 'system'
} as const
export type NotificationGroup = (typeof NotificationGroups)[keyof typeof NotificationGroups]

const { CONVERSATIONS, MESSAGES, ORDERS, INVENTORY, SHIPPING, TEAM, SYSTEM } = NotificationGroups

export const NotificationGroupTypes: Record<NotificationGroup, readonly NotificationType[]> = {
  [CONVERSATIONS]: [
    NotificationTypes.CONVERSATION_ASSIGNED,
    NotificationTypes.CONVERSATION_MENTIONED,
    NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE,
    NotificationTypes.CONVERSATION_SNOOZE_EXPIRED,
    NotificationTypes.CONVERSATION_REOPENED
  ],
  [MESSAGES]: [NotificationTypes.MESSAGE_RECEIVED, NotificationTypes.MESSAGE_FAILED],
  [ORDERS]: [
    NotificationTypes.ORDER_CREATED,
    NotificationTypes.ORDER_STATUS_CHANGED,
    NotificationTypes.ORDER_PAYMENT_FAILED,
    NotificationTypes.ORDER_MESSAGE_NOT_SENT,
    NotificationTypes.ORDER_PRICE_APPROVAL_REQUESTED,
    NotificationTypes.ORDER_PRICE_OVERRIDDEN,
    NotificationTypes.ORDER_PACKING_NOTE_CHANGED
  ],
  [INVENTORY]: [
    NotificationTypes.INVENTORY_LOW,
    NotificationTypes.TRANSFER_DISPATCHED,
    NotificationTypes.COUNT_AWAITING_APPLY
  ],
  [SHIPPING]: [
    NotificationTypes.PICKUP_CUTOFF_APPROACHING,
    NotificationTypes.PICKUP_MANUAL_REQUIRED,
    NotificationTypes.SHIPMENT_CANCEL_FAILED,
    NotificationTypes.SHIPMENT_REQUIRES_REVIEW,
    NotificationTypes.SHIPMENT_FAILED_ATTEMPT,
    NotificationTypes.CARRIER_STATUS_UNMAPPED,
    NotificationTypes.BULK_LABELS_READY,
    NotificationTypes.RETURN_AWAITING_RECEIPT,
    NotificationTypes.REMITTANCE_OVERDUE
  ],
  [TEAM]: [NotificationTypes.MEMBER_JOINED, NotificationTypes.INVITATION_ACCEPTED],
  [SYSTEM]: [
    NotificationTypes.CHANNEL_DISCONNECTED,
    NotificationTypes.CHANNEL_TOKEN_EXPIRING,
    NotificationTypes.WEBHOOK_AUTO_DISABLED,
    NotificationTypes.PLUGIN_ERROR,
    NotificationTypes.EXPORT_READY,
    NotificationTypes.EXPORT_FAILED,
    NotificationTypes.MEDIA_INFECTED,
    NotificationTypes.MEDIA_UNSCANNABLE
  ]
}

// Types that nothing raises yet. The preferences page hides their switches (a switch that changes
// nothing misleads) and shows each one when the step that emits it is done: Commerce (Milestone 4)
// raises the order, inventory and shipping ones; Step 5.4 raises `webhook.auto_disabled`; the plugin
// runtime (Step 5.6) raises `plugin.error`. The constants, texts and defaults stay: the emitter step
// only removes its types from this list.
export const NotificationTypesWithoutEmitter: ReadonlySet<NotificationType> = new Set([
  ...NotificationGroupTypes[ORDERS],
  // `inventory.low` has an emitter since Step 4.2 PR C; the transfer and the count wait for Steps 4.5 and 4.6
  NotificationTypes.TRANSFER_DISPATCHED,
  NotificationTypes.COUNT_AWAITING_APPLY,
  ...NotificationGroupTypes[SHIPPING],
  NotificationTypes.WEBHOOK_AUTO_DISABLED,
  NotificationTypes.PLUGIN_ERROR
])

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
