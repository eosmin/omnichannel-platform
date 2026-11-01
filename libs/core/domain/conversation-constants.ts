import { CustomerLimits } from './customer-constants'
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
// SEND_TEMPLATE is Phase 2 (a template has variables and a window for each conversation, and no flow of
// the MVP sends one in bulk); EXPORT_CSV has no behavior until the exports center of Step 3.4.
export const BulkActions = {
  ASSIGN_TO_ME: 'assign_to_me',
  ASSIGN_TO_AGENT: 'assign_to_agent',
  ROUND_ROBIN_TO_TEAM: 'round_robin_to_team',
  UNASSIGN: 'unassign',
  SET_STATUS: 'set_status',
  ADD_TAG: 'add_tag',
  REMOVE_TAG: 'remove_tag',
  MARK_READ: 'mark_read',
  MARK_UNREAD: 'mark_unread',
  ARCHIVE: 'archive',
  EXPORT_CSV: 'export_csv'
} as const
export type BulkAction = (typeof BulkActions)[keyof typeof BulkActions]

export const BulkLimits = {
  MAX_ITEMS: 500, // "Select all matching this filter" sends the filter; the server caps it here
  // From this many conversations the interface asks before it acts, with a preview of what changes
  // (TDD_09 §10); fewer and reversible, it acts at once and offers Undo
  CONFIRM_FROM: 10
} as const

// Where a template stands with the provider: only an approved one can be sent
export const TemplateStatuses = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected'
} as const
export type TemplateStatus = (typeof TemplateStatuses)[keyof typeof TemplateStatuses]

// Characters that reorder or hide text (bidi controls, zero-width ones): they reach the customer as
// they are written, so they are refused in what an agent types into a template and taken out of what
// a provider says
export const MisleadingTextPattern = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u

export const MessageLimits = {
  // The longest text WhatsApp takes in one message; the other channels take less or the same
  CONTENT_MAX_LENGTH: 4096,
  IDEMPOTENCY_KEY_MAX_LENGTH: 128,
  MAX_MENTIONS: 10,
  // A template of WhatsApp: its name, its language code and the values of its numbered variables
  TEMPLATE_NAME_MAX_LENGTH: 512,
  TEMPLATE_LANGUAGE_MAX_LENGTH: 16,
  // How much of the quoted message the bubble of a reply carries
  QUOTE_PREVIEW_MAX_LENGTH: 200,
  TEMPLATE_MAX_VARIABLES: 20,
  TEMPLATE_VARIABLE_MAX_LENGTH: 1024
} as const

// The keys a channel plugin may add to its answer to a send (`ChannelMessageResult.metadata`), and the
// core keeps. Instagram and Messenger cannot put a caption on a file: the plugin sends it as a second
// message and gives the id of that one here.
export const ChannelResultMetadata = {
  CAPTION_EXTERNAL_ID: 'captionExternalId'
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
// Where a conversation came from: an ad, a post, or something a provider does not name. Channel
// agnostic; each plugin fills it from what its provider sends.
export const OriginKinds = {
  AD: 'ad',
  POST: 'post',
  OTHER: 'other'
} as const
export type OriginKind = (typeof OriginKinds)[keyof typeof OriginKinds]

export const OriginMediaTypes = {
  IMAGE: 'image',
  VIDEO: 'video'
} as const
export type OriginMediaType = (typeof OriginMediaTypes)[keyof typeof OriginMediaTypes]

// Who acted on a message (reacted to it, edited it, deleted it), as a plugin can tell: the customer, or
// the owner from the provider's own app. An agent of the platform acts through the api, never through
// a channel event.
export const ReactionActors = {
  CUSTOMER: 'customer',
  EXTERNAL: 'external'
} as const
export type ReactionActor = (typeof ReactionActors)[keyof typeof ReactionActors]

// A deleted message keeps its text for this long, for disputes, and then a job purges it.
// The same goes for the text of a revision. (Phase 2: a store preference.)
export const DeletedMessageRetention = {
  DAYS: 30,
  PURGE_BATCH: 200
} as const

export const InboundLimits = {
  MAX_EVENTS_PER_REQUEST: 100,
  ID_MAX_LENGTH: 255,
  CONTENT_MAX_LENGTH: 65_536,
  MEDIA_REF_MAX_LENGTH: 2048,
  // Meta takes up to 30 images in one send, so a customer's message can bring as many
  MAX_MEDIA_PER_MESSAGE: 30,
  // The origin of a message (an ad it came from): texts a provider sends are cut to fit, not refused
  ORIGIN_TITLE_MAX_LENGTH: 255,
  ORIGIN_BODY_MAX_LENGTH: 2000,
  FILENAME_MAX_LENGTH: 255,
  CONTENT_TYPE_MAX_LENGTH: 127,
  // An email or a phone a person typed in a form; the core cleans what it keeps
  PROFILE_FIELD_MAX_LENGTH: CustomerLimits.EMAIL_MAX_LENGTH,
  // An emoji is a few code points (a flag, a family, a skin tone); the limit is in UTF-16 units
  EMOJI_MAX_LENGTH: 32,
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

// The presets of the snooze menu; the hour is the wall clock of the store
export const SnoozePresets = {
  LATER_TODAY_HOURS: 3,
  MORNING_HOUR: 9
} as const

// Resolving without the options dialog shows a toast that takes it back
export const ResolveUndo = {
  DURATION_MS: 10_000,
  // The closing message waits this much longer than the toast: an Undo clicked in the last second
  // reaches the api after the toast is gone
  CLOSING_GRACE_MS: 2_000
} as const

export const ConversationLimits = {
  RESOLUTION_REASON_MAX_LENGTH: 500,
  MAX_SNOOZE_DAYS: 365,
  PREVIEW_MAX_LENGTH: 140,
  // The tags of a conversation travel with every row of the list: the number is bounded
  MAX_TAGS_PER_CONVERSATION: 20,
  // The origins of a conversation the thread reads at once, newest first: a customer who comes back
  // from many ads has more, and the card shows the latest
  MAX_ORIGINS_LISTED: 50
} as const

// The emoji an agent can leave with one click. They are the content of a reaction, not decoration of
// the interface (rule 9 is about the latter); any other emoji goes through the "other" dialog.
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const
