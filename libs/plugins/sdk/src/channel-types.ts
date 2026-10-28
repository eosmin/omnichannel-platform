import type {
  DeliveryStatus,
  MessageType,
  MessagingWindowPolicy,
  OriginKind,
  OriginMediaType
} from '@platform/core/domain'

export const ChannelEventTypes = {
  MESSAGE_RECEIVED: 'message_received',
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
  // account id, widget site key, inbound mailbox. It resolves the store.
  connectionId: string
  // The customer's handle on this channel: phone (E.164 without '+'), page-scoped id, widget
  // visitor id, email address
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

export interface FetchedMedia {
  stream: NodeJS.ReadableStream
  contentType: string
  contentLength: number | null
}
