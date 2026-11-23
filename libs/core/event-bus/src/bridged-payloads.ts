import { z } from 'zod'

import {
  AttentionReasons,
  AuthorType,
  BenefitAlertLevel,
  BulkLabelJobStatus,
  CarrierStatusLimits,
  CHANNEL_ID_PATTERN,
  ChainProblem,
  ConversationStatus,
  ConversationStatusReasons,
  FinanceEventKind,
  FinancePostingFailureReason,
  FinanceSourceType,
  FiscalContingencyAlertKind,
  FiscalLimits,
  GuideBalanceAlertLevel,
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
    visibility,
    // Only the api publishes a plugin's read; kept here so a payload that crosses the bridge never loses it
    byPlugin: z.literal(true).optional()
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
  [Events.CUSTOMER_CREATED]: z.object({ storeId: id, customerId: id }),
  [Events.SHIPMENT_CREATED]: shipmentEvent,
  [Events.SHIPMENT_CANCELLED]: shipmentEvent,
  [Events.SHIPMENT_REQUIRES_REVIEW]: shipmentEvent,
  [Events.SHIPMENT_CANCEL_FAILED]: shipmentEvent,
  // The ids of the connection and the carrier's code, normalized and bounded: no description, no customer data
  [Events.CARRIER_STATUS_UNMAPPED]: z.object({
    storeId: id,
    connectionId: id,
    providerCode: z.string().min(1).max(CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH)
  }),
  // The balance of prepaid guides and the refund benefit of a connection: ids, a level and numbers, nothing else
  [Events.CARRIER_GUIDE_BALANCE_ALERT]: z.object({
    storeId: id,
    connectionId: id,
    level: z.enum(GuideBalanceAlertLevel),
    balance: z.number().int()
  }),
  [Events.CARRIER_BENEFIT_ALERT]: z.object({
    storeId: id,
    connectionId: id,
    level: z.enum(BenefitAlertLevel),
    rateBps: z.number().int().min(0),
    thresholdBps: z.number().int().min(1)
  }),
  // The cash on delivery a carrier has kept too long: ids and numbers, no guide, no customer
  [Events.REMITTANCE_OVERDUE]: z.object({
    storeId: id,
    connectionId: id,
    count: z.number().int().min(1),
    overdueAfterDays: z.number().int().min(1),
    oldestAgeDays: z.number().int().min(0),
    totalOwedCents: z.number().int().min(0)
  }),
  // A data request that needs the reviewers: ids and a code, never an address or a name
  [Events.DSR_DEADLINE_APPROACHING]: z.object({
    storeId: id,
    requestId: id,
    type: z.string().min(1).max(32),
    daysLeft: z.number().int().min(0).max(366)
  }),
  [Events.DSR_RETURNED_TO_REVIEW]: z.object({
    storeId: id,
    requestId: id,
    type: z.string().min(1).max(32),
    reason: z.string().min(1).max(64)
  }),
  [Events.DSR_NOTICE_FAILED]: z.object({
    storeId: id,
    requestId: id,
    type: z.string().min(1).max(32),
    reason: z.string().min(1).max(64)
  }),
  // A webhook turned off: its id and the count of failures, never its address or the response that failed
  [Events.WEBHOOK_AUTO_DISABLED]: z.object({
    storeId: id,
    webhookId: id,
    consecutiveFailures: z.number().int().min(1)
  }),
  // An automatic entry failed: the source, the event of it and a reason code, never an amount
  [Events.FINANCE_POSTING_FAILED]: z.object({
    organizationId: id,
    sourceType: z.enum(FinanceSourceType),
    sourceId: id,
    eventKind: z.enum(FinanceEventKind),
    reason: z.enum(FinancePostingFailureReason),
    attempts: z.number().int().min(1)
  }),
  // The weekly check of the chain opened an incident: the organization and the code of what broke
  [Events.FINANCE_CHAIN_BROKEN]: z.object({ organizationId: id, reason: z.enum(ChainProblem) }),
  // A fiscal document was refused: ids and the reason code, never the receiver's data
  [Events.FISCAL_DOCUMENT_REJECTED]: z.object({
    organizationId: id,
    storeId: id,
    documentId: id,
    orderId: id,
    reason: z.string().max(FiscalLimits.REASON_MAX_LENGTH)
  }),
  // A fiscal document ran out of attempts while it waited for the provider: ids and the count
  [Events.FISCAL_DOCUMENT_STUCK]: z.object({
    organizationId: id,
    storeId: id,
    documentId: id,
    orderId: id,
    attempts: z.number().int().min(1)
  }),
  // A sale document disagrees with its entry: the organization, one document and how many
  [Events.FISCAL_ENTRY_MISMATCH]: z.object({
    organizationId: id,
    documentId: id,
    count: z.number().int().min(1)
  }),
  // A contingency needs a person: the organization, the contingency and what happened
  [Events.FISCAL_CONTINGENCY_ALERT]: z.object({
    organizationId: id,
    contingencyId: id,
    kind: z.enum(FiscalContingencyAlertKind)
  }),
  // The webhooks of a plugin turned off: the installation, the plugin and the count, never the address or the response
  [Events.PLUGIN_ERROR]: z.object({
    storeId: id,
    installationId: id,
    pluginId: z.string().regex(CHANNEL_ID_PATTERN),
    consecutiveFailures: z.number().int().min(1)
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
  [Events.PICKUP_CUTOFF_APPROACHING]: z.object({
    storeId: id,
    connectionId: id,
    pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    waiting: z.number().int().min(0),
    minutesLeft: z.number().int().min(0)
  }),
  [Events.MESSAGE_NOTE_ADDED]: z.object({
    storeId: id,
    conversationId: id,
    messageId: id,
    // Null for a note a plugin wrote as the system
    authorId: id.nullable(),
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
