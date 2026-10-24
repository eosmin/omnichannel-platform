import { NotificationChannel } from '../index'

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
  WEBHOOK_AUTO_DISABLED: 'webhook.auto_disabled',
  PLUGIN_ERROR: 'plugin.error',
  EXPORT_READY: 'export.ready',
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
//   IN_APP always. PUSH when someone must act soon or it is time-sensitive. EMAIL when money or a
//   legal deadline is involved, or the person may be away from the app. SOUND for inbox events only.
// Default delivery matrix per type: complete, one entry per NotificationType. TDD_09 §9 renders
// exactly this matrix; the two must never disagree.
export const NotificationDefaults: Record<NotificationType, NotificationDefault> = {
  [NotificationTypes.CONVERSATION_ASSIGNED]: { severity: INFO, channels: [IN_APP, PUSH, SOUND] },
  [NotificationTypes.CONVERSATION_MENTIONED]: {
    severity: INFO,
    channels: [IN_APP, PUSH, EMAIL, SOUND]
  },
  [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.CONVERSATION_SNOOZE_EXPIRED]: {
    severity: INFO,
    channels: [IN_APP, PUSH, SOUND]
  },
  [NotificationTypes.CONVERSATION_REOPENED]: { severity: INFO, channels: [IN_APP, PUSH] },
  [NotificationTypes.MESSAGE_RECEIVED]: { severity: INFO, channels: [IN_APP, SOUND] },
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
  [NotificationTypes.WEBHOOK_AUTO_DISABLED]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.PLUGIN_ERROR]: { severity: ERROR, channels: [IN_APP] },
  [NotificationTypes.EXPORT_READY]: { severity: SUCCESS, channels: [IN_APP] },
  [NotificationTypes.DSR_DEADLINE_APPROACHING]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.DSR_MANUAL_REVIEW]: { severity: INFO, channels: [IN_APP, EMAIL] }
}

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
