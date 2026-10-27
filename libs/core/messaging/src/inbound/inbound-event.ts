import type { MessageType } from '@platform/core/domain'

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// What the pipeline needs of a message that a channel received. The worker checks the event of the
// plugin (channelEventSchema) before it gets here, and this is the part of it that the core reads; the
// core does not depend on the plugin SDK.
export interface InboundMessage {
  externalId: string
  type: MessageType
  content: string | null
  media?: { ref: string; contentType: string; filename: string | null } | undefined
  replyToExternalId?: string | undefined
  metadata?: Record<string, JsonValue> | undefined
  timestamp: string
}

export interface InboundEvent {
  connectionId: string
  channelIdentity: string
  channelProfile?: { displayName?: string | undefined; locale?: string | undefined } | undefined
  message: InboundMessage
}

export const InboundOutcomes = {
  STORED: 'stored',
  DUPLICATE: 'duplicate',
  UNKNOWN_CONNECTION: 'unknown_connection'
} as const
export type InboundOutcome = (typeof InboundOutcomes)[keyof typeof InboundOutcomes]
