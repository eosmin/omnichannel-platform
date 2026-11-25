import { NotificationChannel } from '../status-enums'

import {
  NotificationSeverity,
  type NotificationSeverityType,
  type NotificationType,
  NotificationTypes
} from './notification-constants'

// The delivery matrix of the notifications: what each type does by default, how the preferences page groups them, which ones cannot be
// turned off. It lives apart from `notification-constants.ts` (the names and the severity every screen reads) because its tables read the
// type names as keys at the top of the file, which keeps them in the first load of every page that reads any name; only the preferences
// page and the server read them (apps/web/lib/shared-chunk-imports.spec.ts).

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
  [NotificationTypes.CARRIER_GUIDE_BALANCE_LOW]: { severity: WARNING, channels: [IN_APP] },
  [NotificationTypes.CARRIER_GUIDE_BALANCE_EMPTY]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.CARRIER_BENEFIT_AT_RISK]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.CARRIER_BENEFIT_LOST]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.MEMBER_JOINED]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.INVITATION_ACCEPTED]: { severity: INFO, channels: [IN_APP] },
  [NotificationTypes.CHANNEL_DISCONNECTED]: { severity: ERROR, channels: [IN_APP, PUSH, EMAIL] },
  [NotificationTypes.CHANNEL_TOKEN_EXPIRING]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.WEBHOOK_AUTO_DISABLED]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.PLUGIN_ERROR]: { severity: ERROR, channels: [IN_APP] },
  [NotificationTypes.FINANCE_POSTING_FAILED]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FINANCE_ADVANCE_OWED]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FINANCE_CHAIN_BROKEN]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FISCAL_DOCUMENT_REJECTED]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FISCAL_DOCUMENT_STUCK]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FISCAL_RETRANSMIT_DEADLINE]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FISCAL_DELIVERY_NOT_SENT]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FISCAL_ENTRY_MISMATCH]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FISCAL_CONTINGENCY_OPENED]: { severity: ERROR, channels: [IN_APP, EMAIL] },
  [NotificationTypes.FISCAL_CONTINGENCY_REPORT_FAILED]: {
    severity: ERROR,
    channels: [IN_APP, EMAIL]
  },
  [NotificationTypes.FISCAL_CONTINGENCY_WINDOW_CLOSING]: {
    severity: ERROR,
    channels: [IN_APP, EMAIL]
  },
  [NotificationTypes.EXPORT_READY]: { severity: SUCCESS, channels: [IN_APP] },
  [NotificationTypes.EXPORT_FAILED]: { severity: ERROR, channels: [IN_APP] },
  [NotificationTypes.MEDIA_INFECTED]: { severity: WARNING, channels: [IN_APP, PUSH] },
  [NotificationTypes.MEDIA_UNSCANNABLE]: { severity: WARNING, channels: [IN_APP] },
  [NotificationTypes.DSR_DEADLINE_APPROACHING]: { severity: WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.DSR_MANUAL_REVIEW]: { severity: INFO, channels: [IN_APP, EMAIL] },
  [NotificationTypes.DSR_NOTICE_FAILED]: { severity: ERROR, channels: [IN_APP, EMAIL] }
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
    NotificationTypes.REMITTANCE_OVERDUE,
    NotificationTypes.CARRIER_GUIDE_BALANCE_LOW,
    NotificationTypes.CARRIER_GUIDE_BALANCE_EMPTY,
    NotificationTypes.CARRIER_BENEFIT_AT_RISK,
    NotificationTypes.CARRIER_BENEFIT_LOST
  ],
  [TEAM]: [NotificationTypes.MEMBER_JOINED, NotificationTypes.INVITATION_ACCEPTED],
  [SYSTEM]: [
    NotificationTypes.CHANNEL_DISCONNECTED,
    NotificationTypes.CHANNEL_TOKEN_EXPIRING,
    NotificationTypes.WEBHOOK_AUTO_DISABLED,
    NotificationTypes.PLUGIN_ERROR,
    NotificationTypes.FINANCE_POSTING_FAILED,
    NotificationTypes.FINANCE_ADVANCE_OWED,
    NotificationTypes.FINANCE_CHAIN_BROKEN,
    NotificationTypes.FISCAL_DOCUMENT_REJECTED,
    NotificationTypes.FISCAL_DOCUMENT_STUCK,
    NotificationTypes.FISCAL_RETRANSMIT_DEADLINE,
    NotificationTypes.FISCAL_DELIVERY_NOT_SENT,
    NotificationTypes.FISCAL_ENTRY_MISMATCH,
    NotificationTypes.FISCAL_CONTINGENCY_OPENED,
    NotificationTypes.FISCAL_CONTINGENCY_REPORT_FAILED,
    NotificationTypes.FISCAL_CONTINGENCY_WINDOW_CLOSING,
    NotificationTypes.EXPORT_READY,
    NotificationTypes.EXPORT_FAILED,
    NotificationTypes.MEDIA_INFECTED,
    NotificationTypes.MEDIA_UNSCANNABLE
  ]
}

// The two alerts that cannot be turned off (owner decision, 2026-11-24, BAN-325): a broken chain of the books and a file found
// infected. Every other type, the critical ones too (`dsr.deadline_approaching`, `webhook.auto_disabled`), may be turned off by the
// person. For a locked type the channels it is delivered by at the factory stay on: the server refuses a choice that turns one off
// (`putPreferencesBodySchema`) and reads a stored off as on (`NotificationPreferencesService`), and the page draws those switches
// locked.
export const NotificationLockedTypes: ReadonlySet<NotificationType> = new Set([
  NotificationTypes.FINANCE_CHAIN_BROKEN,
  NotificationTypes.MEDIA_INFECTED
])

// The names the preference rows give to the channels of `NotificationChannel`
export const NotificationChannelPreferenceKeys = {
  [NotificationChannel.IN_APP]: 'inApp',
  [NotificationChannel.PUSH]: 'push',
  [NotificationChannel.EMAIL]: 'email',
  [NotificationChannel.SOUND]: 'sound'
} as const
export type NotificationChannelPreferenceKey =
  (typeof NotificationChannelPreferenceKeys)[NotificationChannel]

// The channels of a type that the person cannot turn off: its factory channels when it is locked, none otherwise
// (`type` may be any string, the views of the api carry it as one: an unknown type has no lock)
export function lockedChannelsOf(type: string): readonly NotificationChannelPreferenceKey[] {
  const known = Object.values(NotificationTypes).find(candidate => candidate === type)
  if (known === undefined || !NotificationLockedTypes.has(known)) return []
  return NotificationDefaults[known].channels.map(
    channel => NotificationChannelPreferenceKeys[channel]
  )
}

// Types that nothing raises yet. The preferences page hides their switches (a switch that changes
// nothing misleads) and shows each one when the step that emits it is done: Commerce (Milestone 4)
// raises the order, inventory and shipping ones; Step 5.4 PR A raises `webhook.auto_disabled`, and so it is no longer here; the plugin
// runtime raises `plugin.error` since Step 5.6 PR P3, and so it is no longer here either. The constants, texts and defaults stay:
// the emitter step only removes its types from this list.
export const NotificationTypesWithoutEmitter: ReadonlySet<NotificationType> = new Set([
  // The orders raise `order.created`, `order.status_changed`, `order.price_approval_requested`, `order.price_overridden` and
  // `order.packing_note_changed` since Step 4.3 PR B, and `order.message_not_sent` since Step 4.9 PR C2a; the payment failure
  // waits for the online gateway (Phase 2)
  NotificationTypes.ORDER_PAYMENT_FAILED,
  // `inventory.low` has an emitter since Step 4.2 PR C, `transfer.dispatched` since Step 4.5 and `count.awaiting_apply` since
  // Step 4.6
  // `shipment.requires_review` and `shipment.failed_attempt` have an emitter since Step 4.8 PR C2b and `carrier.status_unmapped`
  // since PR C2c, `bulk_labels.ready` since Step 4.10 PR D1, `shipment.cancel_failed` since Step 4.10 PR D2, `pickup.manual_required` and
  // `pickup.cutoff_approaching` since Step 4.11, `return.awaiting_receipt` since Step 4.12 PR R1 and `remittance.overdue` since Step 4.13 PR B; the rest of
  // the shipping group does not yet
  ...NotificationGroupTypes[SHIPPING].filter(
    type =>
      type !== NotificationTypes.SHIPMENT_REQUIRES_REVIEW &&
      type !== NotificationTypes.SHIPMENT_FAILED_ATTEMPT &&
      type !== NotificationTypes.CARRIER_STATUS_UNMAPPED &&
      type !== NotificationTypes.BULK_LABELS_READY &&
      type !== NotificationTypes.SHIPMENT_CANCEL_FAILED &&
      type !== NotificationTypes.PICKUP_MANUAL_REQUIRED &&
      type !== NotificationTypes.PICKUP_CUTOFF_APPROACHING &&
      type !== NotificationTypes.RETURN_AWAITING_RECEIPT &&
      type !== NotificationTypes.REMITTANCE_OVERDUE &&
      // The guide balance and the benefit alerts have an emitter since Step 4.16 PR A
      type !== NotificationTypes.CARRIER_GUIDE_BALANCE_LOW &&
      type !== NotificationTypes.CARRIER_GUIDE_BALANCE_EMPTY &&
      type !== NotificationTypes.CARRIER_BENEFIT_AT_RISK &&
      type !== NotificationTypes.CARRIER_BENEFIT_LOST
  )
])
