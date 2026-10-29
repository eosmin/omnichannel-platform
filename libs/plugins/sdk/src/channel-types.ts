import type {
  DeliveryStatus,
  MessageType,
  MessagingWindowPolicy,
  OriginKind,
  OriginMediaType,
  ReactionActor
} from '@platform/core/domain'

export const ChannelEventTypes = {
  MESSAGE_RECEIVED: 'message_received',
  // A message written in the provider's own app (the owner's phone), which the provider echoes to us
  MESSAGE_ECHO: 'message_echo',
  // Someone reacted to a message, or took the reaction back
  MESSAGE_REACTION: 'message_reaction',
  // A message was edited or deleted at the provider, by the customer or by the owner in the provider's app
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_DELIVERED: 'message_delivered',
  MESSAGE_READ: 'message_read',
  MESSAGE_FAILED: 'message_failed',
  CUSTOMER_TYPING: 'customer_typing',
  CONNECTION_ERROR: 'connection_error' // e.g. a token revoked, reported by the provider
} as const

export type ChannelEventType = (typeof ChannelEventTypes)[keyof typeof ChannelEventTypes]

// A file the customer attached. `ref` is whatever the plugin's `fetchMedia` needs to get it: a media
// id (WhatsApp) or a url (Instagram, Messenger).
export interface ChannelMedia {
  ref: string
  contentType: string
  filename: string | null
}

// Where the message came from, when the customer arrived through an ad or a post. Every field is
// optional because a provider sends what it has: sometimes only a link. The media is either a
// provider reference (fetched with `fetchMedia`, like any media) or a url, never both. `referral`
// is what the provider sent, untouched, so that the first real ad teaches what the fields missed.
export interface ChannelOrigin {
  kind: OriginKind
  sourceId?: string
  sourceUrl?: string
  title?: string
  body?: string
  media?: { type: OriginMediaType; ref?: string; url?: string }
  thumbnailUrl?: string
  clickId?: string
  referral?: Record<string, unknown>
}

export interface ChannelEvent {
  type: ChannelEventType
  // The RECIPIENT of the event: WhatsApp phone_number_id, Facebook Page id, Instagram business
  // account id, widget site key. It resolves the store.
  connectionId: string
  // The customer's handle on this channel: phone (E.164 without '+'), page-scoped id, widget
  // visitor id
  channelIdentity: string
  channelProfile?: { displayName?: string; avatarUrl?: string; locale?: string }
  message?: {
    externalId: string
    type: MessageType
    content: string | null
    // Fetched later by the core. One message can carry several (an album): the core stores them all
    // on the same message.
    media?: readonly ChannelMedia[]
    origin?: ChannelOrigin
    replyToExternalId?: string
    metadata?: Record<string, unknown>
    timestamp: string // ISO 8601
  }
  // For reaction events: the message reacted to, by its provider id. A null emoji takes the reaction back.
  // `eventId` is the provider's id of the reaction itself, when it has one: a delivery sent twice has
  // the same, two reactions in one second do not.
  reaction?: {
    targetExternalId: string
    emoji: string | null
    from?: ReactionActor
    eventId?: string
  }
  // For edit events: the message edited, by its provider id, with its whole new text. `eventId` is the
  // provider's id of the edit itself, when it has one: a delivery sent twice has the same, two edits of
  // the same message do not.
  edit?: { targetExternalId: string; content: string; from?: ReactionActor; eventId?: string }
  // For delete events: the message deleted, by its provider id
  deletion?: { targetExternalId: string; from?: ReactionActor; eventId?: string }
  // For delivery, read and failed events
  status?: { externalId: string; error?: { code: string; message: string } }
  // Message.id of a message the platform sent: lets a remote plugin's status event find it
  messageId?: string
  timestamp: string
}

export interface ChannelContext {
  storeId: string
  connectionId: string
  // Decrypted by the core just for this call; the plugin's schema validates its shape
  credentials: Record<string, unknown>
  // ChannelConnection.metadata
  metadata: Record<string, unknown>
}

export interface ConnectInput {
  storeId: string
  credentials: Record<string, unknown>
}

export interface ConnectResult {
  connectionId: string
  // Shown in the UI: phone number, page name, site domain, mailbox
  displayName: string
  // What to persist; it may differ from the input (an exchanged long-lived token)
  credentials: Record<string, unknown>
  metadata: Record<string, unknown>
}

export interface ChannelHealth {
  healthy: boolean
  checkedAt: string
  error?: string
}

export type { MessagingWindowPolicy }

export interface ChannelMessageResult {
  externalId: string
  status: DeliveryStatus
  sentAt: string
  metadata?: Record<string, unknown>
}

export interface SendMessageParams {
  channelIdentity: string
  content: string
  replyToExternalId?: string
  // Message.id: providers that support idempotency get it
  idempotencyKey: string
}

export interface SendMediaParams {
  channelIdentity: string
  mediaUrl: string
  contentType: string
  filename: string | null
  caption?: string
  replyToExternalId?: string
  idempotencyKey: string
}

export interface MessageTemplate {
  name: string
  language: string
  status: 'approved' | 'pending' | 'rejected'
  body: string
}

export interface SendTemplateParams {
  channelIdentity: string
  templateName: string
  language: string
  variables: readonly string[]
  idempotencyKey: string
}

export interface SendButtonsParams {
  channelIdentity: string
  content: string
  buttons: readonly { id: string; title: string }[]
  idempotencyKey: string
}

export interface SendLocationParams {
  channelIdentity: string
  latitude: number
  longitude: number
  name?: string
  idempotencyKey: string
}

export interface TypingParams {
  channelIdentity: string
}

export interface MarkReadParams {
  channelIdentity: string
  externalId: string
}

// An agent's reaction to a message, by the provider id of the message. A null emoji takes it back. The
// plugin refuses (a non-retryable PluginError) what its provider does not allow, such as a message of
// ours or one older than the provider accepts.
export interface SendReactionParams {
  channelIdentity: string
  targetExternalId: string
  emoji: string | null
}

// An agent's deletion of a message of ours, for everyone, by its provider id. The plugin refuses (a
// non-retryable PluginError) what its provider does not allow, such as a message past its time limit.
export interface DeleteMessageParams {
  channelIdentity: string
  targetExternalId: string
}

// An agent's edit of a message of ours, by its provider id, with the whole new text. The plugin refuses
// (a non-retryable PluginError) what its provider does not allow, such as a media message or one past
// its time limit.
export interface EditMessageParams {
  channelIdentity: string
  targetExternalId: string
  content: string
}

// What a channel keeps for a customer, as the plugin read it. Every field is optional because a
// provider shows what the person made public: Instagram may have no name, Messenger needs a feature
// approved for the app. `avatarUrl` is a link that expires; the core does not store the photo yet.
export interface ChannelCustomerProfile {
  name?: string
  username?: string
  avatarUrl?: string
}

export interface FetchedMedia {
  stream: NodeJS.ReadableStream
  contentType: string
  contentLength: number | null
}
