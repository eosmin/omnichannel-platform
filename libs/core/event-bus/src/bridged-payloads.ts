import { z } from 'zod'

import {
  AttentionReasons,
  AuthorType,
  BulkLabelJobStatus,
  CarrierStatusLimits,
  CHANNEL_ID_PATTERN,
  ConversationStatus,
  ConversationStatusReasons,
  idempotencyKeySchema,
  PickupManualReasons,
  ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type BridgedEvent,
  BridgedEvents,
  ChannelDisconnectedReasons,
  type BridgedPayloads,
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
const exportSettled = z.object({
  storeId: id,
  exportId: id,
  requestedBy: id,
  exportType: z.string().min(1).max(64)
})
const actor = z.object({ type: z.enum(['user', 'system']), id: id.nullable() })
const shipmentEvent = z.object({
  storeId: id,
  shipmentId: id,
  orderId: id,
  orderNumber: z.string().min(1).max(64),
  connectionId: id,
  actor
})

// What may cross from the worker to the api, event by event. Parsing keeps only these fields: a
// payload that grows a text field one day does not carry it over the channel, and a message from
// anyone else that does not fit is dropped before any listener reads it.
// Typed against the payloads of the events: a field that changes there stops this from compiling,
// instead of making every such event fail to parse at run time.
const schemas: { [E in BridgedEvent]: z.ZodType<BridgedPayloads[E], unknown> } = {
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
  [Events.CONVERSATION_SNOOZE_EXPIRED]: z.object({
    storeId: id,
    conversationId: id,
    assignedTo: id.nullable()
  }),
  [Events.CONVERSATION_REOPENED]: z.object({
    storeId: id,
    conversationId: id,
    assignedTo: id.nullable(),
    reason: z.enum(ConversationStatusReasons).nullable(),
    reopenedBy: actor
  }),
  [Events.CONVERSATION_UNASSIGNED]: z.object({
    storeId: id,
    conversationId: id,
    unassignedBy: actor
  }),
  [Events.CONVERSATION_CREATED]: z.object({
    storeId: id,
    conversationId: id,
    customerId: id,
    channelType: z.string().regex(CHANNEL_ID_PATTERN),
    firstMessageId: id,
    visibility
  }),
  [Events.MESSAGE_RECEIVED]: z.object({
    storeId: id,
    conversationId: id,
    messageId: id,
    customerId: id,
    channelType: z.string().regex(CHANNEL_ID_PATTERN),
    authorType: z.enum(AuthorType),
    receivedAt: z.iso.datetime(),
    visibility
  }),
  [Events.CONVERSATION_READ]: z.object({
    storeId: id,
    conversationId: id,
    userId: id,
    visibility
  }),
  [Events.CONVERSATION_ATTENTION_CHANGED]: z.object({
    storeId: id,
    conversationId: id,
    reason: z.enum(AttentionReasons).nullable(),
    visibility
  }),
  [Events.MESSAGE_QUEUED]: z.object({
    storeId: id,
    conversationId: id,
    messageId: id,
    authorId: id.nullable(),
    clientMessageId: idempotencyKeySchema.nullable(),
    createdAt: z.iso.datetime(),
    visibility
  }),
  [Events.MESSAGE_SENT]: status,
  [Events.MESSAGE_DELIVERED]: status,
  [Events.MESSAGE_READ]: status,
  [Events.MESSAGE_REACTION]: status,
  [Events.MESSAGE_EDITED]: status.extend({ internal: z.boolean() }),
  [Events.MESSAGE_DELETED]: status.extend({ internal: z.boolean() }),
  // A file of a message was scanned (clean, or its variants are ready) or found infected: ids only,
  // the thread reads the state through the api
  [Events.MEDIA_PROCESSED]: status.extend({ internal: z.boolean() }),
  [Events.MEDIA_INFECTED]: status.extend({ internal: z.boolean() }),
  [Events.MEDIA_UNSCANNABLE]: status.extend({ internal: z.boolean() }),
  [Events.MEDIA_UNAVAILABLE]: status.extend({ internal: z.boolean() }),
  // An export settled: the ids and the kind, no file name and no path
  [Events.EXPORT_READY]: exportSettled,
  [Events.EXPORT_FAILED]: exportSettled,
  [Events.MESSAGE_FAILED]: status.extend({ errorCode: z.enum(ErrorCodes) }),
  // The ids of a connection, no text: what the health check of the worker announces
  [Events.CHANNEL_DISCONNECTED]: z.object({
    storeId: id,
    channelConnectionId: id,
    pluginId: z.string().regex(CHANNEL_ID_PATTERN),
    reason: z.enum(ChannelDisconnectedReasons)
  }),
  [Events.CHANNEL_TOKEN_EXPIRING]: z.object({
    storeId: id,
    channelConnectionId: id,
    pluginId: z.string().regex(CHANNEL_ID_PATTERN),
    expiresAt: z.iso.datetime()
  }),
  [Events.CHANNEL_HEALTH_RESTORED]: z.object({
    storeId: id,
    channelConnectionId: id,
    pluginId: z.string().regex(CHANNEL_ID_PATTERN)
  }),
  // A shipment moved: ids, the two statuses and who did it; no address, no phone, no carrier text
  [Events.SHIPMENT_STATUS_CHANGED]: shipmentEvent.extend({
    from: z.enum(ShipmentStatus),
    to: z.enum(ShipmentStatus),
    // The move replays an event kept under a code the owner has just mapped: nobody outside the team hears of it
    replay: z.boolean().optional()
  }),
  [Events.SHIPMENT_REQUIRES_REVIEW]: shipmentEvent,
  [Events.SHIPMENT_CANCEL_FAILED]: shipmentEvent,
  // The ids of the connection and the carrier's code, normalized and bounded: no description, no customer data
  [Events.CARRIER_STATUS_UNMAPPED]: z.object({
    storeId: id,
    connectionId: id,
    providerCode: z.string().min(1).max(CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH)
  }),
  // The cash on delivery a carrier has kept too long: ids and numbers, no guide, no customer
  [Events.REMITTANCE_OVERDUE]: z.object({
    storeId: id,
    connectionId: id,
    count: z.number().int().min(1),
    overdueAfterDays: z.number().int().min(1),
    oldestAgeDays: z.number().int().min(0),
    totalOwedCents: z.number().int()
  }),
  // A bulk run of labels: ids and counts, never what was made of each order
  [Events.BULK_LABELS_PROGRESS]: z.object({
    storeId: id,
    jobId: id,
    requestedBy: id,
    done: z.number().int().min(0),
    total: z.number().int().min(1),
    failed: z.number().int().min(0)
  }),
  [Events.BULK_LABELS_DONE]: z.object({
    storeId: id,
    jobId: id,
    requestedBy: id,
    status: z.enum(BulkLabelJobStatus),
    mergedMediaId: id.nullable()
  }),
  // A pickup that needs a person: ids, the day, the count and why; nothing the carrier said
  [Events.PICKUP_MANUAL_REQUIRED]: z.object({
    storeId: id,
    pickupId: id,
    connectionId: id,
    pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    packageCount: z.number().int().min(0),
    reason: z.enum(PickupManualReasons)
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
