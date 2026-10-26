import { ConversationStatus } from './status-enums'

// Why a conversation changed status; recorded by ConversationsService.updateStatus. Marking spam
// stays a manual action in the v1.2 MVP, so there is no spam-detected reason.
export const ConversationStatusReasons = {
  SNOOZE_EXPIRED: 'snooze_expired',
  AUTO_ARCHIVED: 'auto_archived',
  CUSTOMER_REPLIED: 'customer_replied'
} as const
export type ConversationStatusReason =
  (typeof ConversationStatusReasons)[keyof typeof ConversationStatusReasons]

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

// Spam and archived conversations are out of the inbox and out of every count (TDD_09 §3.1)
export const ConversationHiddenStatuses = [
  ConversationStatus.SPAM,
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
