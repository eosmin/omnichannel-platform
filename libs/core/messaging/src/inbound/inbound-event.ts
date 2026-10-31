import type { MessageType, OriginKind, OriginMediaType } from '@platform/core/domain'

import type { ChannelProfile } from '../customers/customer-identity.service'

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// What the pipeline needs of a message that a channel received. The worker checks the event of the
// plugin (channelEventSchema) before it gets here, and this is the part of it that the core reads; the
// core does not depend on the plugin SDK.
export interface InboundMedia {
  ref: string
  contentType: string
  filename: string | null
}

// The ad or post a message came from, as the plugin read it from its provider
export interface InboundOrigin {
  kind: OriginKind
  sourceId?: string | undefined
  sourceUrl?: string | undefined
  title?: string | undefined
  body?: string | undefined
  media?: { type: OriginMediaType; ref?: string | undefined; url?: string | undefined } | undefined
  thumbnailUrl?: string | undefined
  clickId?: string | undefined
  referral?: Record<string, JsonValue> | undefined
}

export interface InboundMessage {
  externalId: string
  type: MessageType
  content: string | null
  media?: readonly InboundMedia[] | undefined
  origin?: InboundOrigin | undefined
  replyToExternalId?: string | undefined
  metadata?: Record<string, JsonValue> | undefined
  timestamp: string
}

export interface InboundEvent {
  connectionId: string
  channelIdentity: string
  channelProfile?: ChannelProfile | undefined
  message: InboundMessage
}

export const InboundOutcomes = {
  STORED: 'stored',
  DUPLICATE: 'duplicate',
  UNKNOWN_CONNECTION: 'unknown_connection'
} as const
export type InboundOutcome = (typeof InboundOutcomes)[keyof typeof InboundOutcomes]
