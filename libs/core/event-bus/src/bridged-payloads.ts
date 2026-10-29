import { z } from 'zod'

import { CHANNEL_ID_PATTERN, ConversationStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type BridgedEvent,
  BridgedEvents,
  ChannelDisconnectedReasons,
  type DomainEventPayloads,
  Events
} from '@platform/core/events'

// In lower case, as the gateway names its rooms: 'ABC' and 'abc' are one id to the database
const id = z.uuid().transform(value => value.toLowerCase())
const visibility = z.object({ hidden: z.boolean(), assignedTo: id.nullable() })
const status = z.object({
  storeId: id,
  conversationId: id,
  messageId: id,
  visibility
})
const actor = z.object({ type: z.enum(['user', 'system']), id: id.nullable() })

// What may cross from the worker to the api, event by event. Parsing keeps only these fields: a
// payload that grows a text field one day does not carry it over the channel, and a message from
// anyone else that does not fit is dropped before any listener reads it.
// Typed against the payloads of the events: a field that changes there stops this from compiling,
// instead of making every such event fail to parse at run time.
const schemas: { [E in BridgedEvent]: z.ZodType<DomainEventPayloads[E], unknown> } = {
  [Events.CONVERSATION_STATUS_CHANGED]: z.object({
    storeId: id,
    conversationId: id,
    previousStatus: z.enum(ConversationStatus),
    status: z.enum(ConversationStatus),
    assignedTo: id.nullable(),
    changedBy: actor
  }),
  [Events.CONVERSATION_ASSIGNED]: z.object({
    storeId: id,
    conversationId: id,
    assignedTo: id.nullable(),
    previousAssignee: id.nullable(),
    assignedBy: actor,
    visibility
  }),
  [Events.CONVERSATION_READ]: z.object({
    storeId: id,
    conversationId: id,
    userId: id,
    visibility
  }),
  [Events.MESSAGE_QUEUED]: z.object({
    storeId: id,
    conversationId: id,
    messageId: id,
    authorId: id,
    createdAt: z.iso.datetime(),
    visibility
  }),
  [Events.MESSAGE_SENT]: status,
  [Events.MESSAGE_DELIVERED]: status,
  [Events.MESSAGE_READ]: status,
  [Events.MESSAGE_REACTION]: status,
  [Events.MESSAGE_EDITED]: status.extend({ internal: z.boolean() }),
  [Events.MESSAGE_DELETED]: status.extend({ internal: z.boolean() }),
  [Events.MESSAGE_FAILED]: status.extend({ errorCode: z.enum(ErrorCodes) }),
  // The ids of a connection, no text: what the health check of the worker announces
  [Events.CHANNEL_DISCONNECTED]: z.object({
    storeId: id,
    channelConnectionId: id,
    pluginId: z.string().regex(CHANNEL_ID_PATTERN),
    reason: z.enum(ChannelDisconnectedReasons)
  }),
  [Events.CHANNEL_HEALTH_RESTORED]: z.object({
    storeId: id,
    channelConnectionId: id,
    pluginId: z.string().regex(CHANNEL_ID_PATTERN)
  }),
  [Events.MESSAGE_NOTE_ADDED]: z.object({
    storeId: id,
    conversationId: id,
    messageId: id,
    authorId: id,
    createdAt: z.iso.datetime(),
    visibility
  })
}

// Every bridged event has a schema, and the other way round
for (const event of BridgedEvents) {
  if (!Object.hasOwn(schemas, event)) throw new Error(`no payload schema for the bridged ${event}`)
}

export function isBridged(event: string): boolean {
  return Object.hasOwn(schemas, event)
}

// The payload as the schema of its event keeps it, or null if it does not fit (or is not bridged)
export function bridgedPayload(event: string, payload: unknown): object | null {
  // Own keys only: 'constructor' is not an event
  if (!isBridged(event)) return null
  const schema: z.ZodType<object, unknown> = schemas[event as BridgedEvent]
  const parsed = schema.safeParse(payload)
  return parsed.success ? parsed.data : null
}
