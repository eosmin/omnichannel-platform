import { ConversationStatus, MessageType } from './status-enums'

// Why a conversation changed status; recorded by ConversationsService.updateStatus. Marking spam
// stays a manual action in the v1.2 MVP, so there is no spam-detected reason.
export const ConversationStatusReasons = {
  SNOOZE_EXPIRED: 'snooze_expired',
  AUTO_ARCHIVED: 'auto_archived',
  CUSTOMER_REPLIED: 'customer_replied'
} as const
export type ConversationStatusReason =
  (typeof ConversationStatusReasons)[keyof typeof ConversationStatusReasons]

// What a SYSTEM message of the thread says happened (its `metadata.event`); the thread draws it as a
// divider, in the language of who reads it
export const SystemMessageEvents = {
  RESOLVED: 'resolved',
  REOPENED: 'reopened',
  ARCHIVED: 'archived',
  MARKED_SPAM: 'marked_spam',
  UNMARKED_SPAM: 'unmarked_spam',
  SNOOZED: 'snoozed',
  WOKEN: 'woken',
  ASSIGNED: 'assigned',
  UNASSIGNED: 'unassigned'
} as const
export type SystemMessageEvent = (typeof SystemMessageEvents)[keyof typeof SystemMessageEvents]

// POST /conversations/bulk { action, conversationIds | filter, params } (TDD_09 §10). SET_STATUS
// takes the status in params (open, pending or resolved); the others take their target the same way.
export const BulkActions = {
  ASSIGN_TO_ME: 'assign_to_me',
  ASSIGN_TO_AGENT: 'assign_to_agent',
  ROUND_ROBIN_TO_TEAM: 'round_robin_to_team',
  UNASSIGN: 'unassign',
  SET_STATUS: 'set_status',
  ADD_TAG: 'add_tag',
  REMOVE_TAG: 'remove_tag',
  SEND_TEMPLATE: 'send_template',
  MARK_READ: 'mark_read',
  MARK_UNREAD: 'mark_unread',
  ARCHIVE: 'archive',
  EXPORT_CSV: 'export_csv'
} as const
export type BulkAction = (typeof BulkActions)[keyof typeof BulkActions]

export const BulkLimits = {
  MAX_ITEMS: 500 // "Select all matching this filter" sends the filter; the server caps it here
} as const

export const MessageLimits = {
  // The longest text WhatsApp takes in one message; the other channels take less or the same
  CONTENT_MAX_LENGTH: 4096,
  IDEMPOTENCY_KEY_MAX_LENGTH: 128,
  MAX_MENTIONS: 10
} as const

// What a channel plugin may say a customer sent. A plugin is not trusted with the types that only the
// platform writes (SYSTEM lines, internal notes, cards).
export const InboundMessageTypes = [
  MessageType.TEXT,
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT,
  MessageType.LOCATION
] as const

// Bounds on what a channel event may carry: it comes from a provider, or from a plugin that is not ours
export const InboundLimits = {
  MAX_EVENTS_PER_REQUEST: 100,
  ID_MAX_LENGTH: 255,
  CONTENT_MAX_LENGTH: 65_536,
  MEDIA_REF_MAX_LENGTH: 2048,
  FILENAME_MAX_LENGTH: 255,
  CONTENT_TYPE_MAX_LENGTH: 127,
  METADATA_MAX_BYTES: 8192,
  // A message dated further ahead than this is dated now: a clock that is wrong must not pin a
  // conversation to the top of the inbox
  MAX_FUTURE_SKEW_MS: 5 * 60 * 1000,
  // And one older than this is a unit mistake (seconds read as milliseconds is 1970), not a message
  // that took a month to arrive
  MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000
} as const

// Spam and archived conversations are out of the inbox and out of every count (TDD_09 §3.1)
export const ConversationHiddenStatuses = [
  ConversationStatus.SPAM,
  ConversationStatus.ARCHIVED
] as const

// An answer of an agent to the customer brings these back to work: the customer is waiting for it
// (spam is not in the list: it is marked as not spam before it is answered)
export const ConversationReopenedByReply = [
  ConversationStatus.RESOLVED,
  ConversationStatus.SNOOZED,
  ConversationStatus.ARCHIVED
] as const

// The values of the `assigned` filter besides a user id
export const ConversationAssignedFilters = {
  ME: 'me',
  UNASSIGNED: 'unassigned'
} as const

export const ConversationLimits = {
  RESOLUTION_REASON_MAX_LENGTH: 500,
  MAX_SNOOZE_DAYS: 365,
  PREVIEW_MAX_LENGTH: 140,
  // The tags of a conversation travel with every row of the list: the number is bounded
  MAX_TAGS_PER_CONVERSATION: 20
} as const
