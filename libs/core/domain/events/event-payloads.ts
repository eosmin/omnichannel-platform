import type { ErrorCode } from '../errors/error-codes'
import type {
  AttentionReason,
  AuthorType,
  ChannelId,
  ConversationStatus,
  ConversationStatusReason,
  InventoryMovementType,
  OrderStatus,
  PaymentStatus
} from '../index'

import type { Events } from './event-names'

// Payloads carry identifiers and plain values only: never Prisma entities or Decimal instances,
// so libs/core/events does not depend on the Prisma client and payloads serialize cleanly into
// BullMQ jobs and webhooks. A listener signature is always
// (payload: <Event>Payload) => Promise<void>; a listener that needs the entity loads it by id.

export interface ActorRef {
  type: 'user' | 'system'
  id: string | null
}

export interface MessageReceivedPayload {
  storeId: string
  conversationId: string
  messageId: string
  customerId: string
  channelType: ChannelId
  authorType: AuthorType
  contentPreview: string | null // First 200 chars, for listeners that only need a glance
  receivedAt: string // ISO 8601
  visibility: ConversationVisibility
}

export interface ConversationCreatedPayload {
  storeId: string
  conversationId: string
  customerId: string
  channelType: ChannelId
  firstMessageId: string // Emitted after the first message is persisted, never before
  firstMessageContent: string | null
  visibility: ConversationVisibility
}

export interface ConversationStatusChangedPayload {
  storeId: string
  conversationId: string
  previousStatus: ConversationStatus
  status: ConversationStatus
  assignedTo: string | null
  changedBy: ActorRef
}

// A resolved or archived conversation became open again. `reason` is why the system did it (null when a
// person asked for it). Ids only: who is told is decided when the notification is made.
export interface ConversationReopenedPayload {
  storeId: string
  conversationId: string
  assignedTo: string | null
  reason: ConversationStatusReason | null
  reopenedBy: ActorRef
}

// The team's queue got a conversation nobody owns: routing left it without an owner, or a person gave it up
export interface ConversationUnassignedPayload {
  storeId: string
  conversationId: string
  unassignedBy: ActorRef
}

// Who may see a conversation once the change is made: a hidden one (archived or spam) is for who may
// archive, one with an assignee is for the assignee and who sees all, one without is for who sees
// conversations. It travels in the payload so that whoever broadcasts an event can pick its audience
// from what the transaction decided, without reading the row again.
export interface ConversationVisibility {
  hidden: boolean
  assignedTo: string | null
}

export interface ConversationAssignedPayload {
  storeId: string
  conversationId: string
  assignedTo: string | null
  previousAssignee: string | null
  assignedBy: ActorRef
  visibility: ConversationVisibility
}

// A snooze reached its moment and the sweep of the worker reopened the conversation. Ids only: who
// is told is decided when the notification is made.
export interface ConversationSnoozeExpiredPayload {
  storeId: string
  conversationId: string
  assignedTo: string | null
}

export interface OrderCreatedPayload extends OrderEventPayload {
  customerId: string
  conversationId: string | null
  totalCents: number
  currency: string
}

// What every event of an order says: which order, and who did it. Ids and numbers only: no note (the customer's, the
// customer care's or the packing one), no address and no phone ever travels in an event (TDD_17 §8), so the payloads
// of the plugin API, the webhooks and the bridge cannot leak them. `actor.id` is null for a change made by the system.
export interface OrderEventPayload {
  storeId: string
  orderId: string
  orderNumber: string
  actor: ActorRef
}

export interface OrderStatusChangedPayload extends OrderEventPayload {
  from: OrderStatus
  to: OrderStatus
}

export interface OrderPaymentPayload extends OrderEventPayload {
  from: PaymentStatus
  to: PaymentStatus
}

// A superset of what the cache listener reads (TDD_16 §5).
export interface InventoryMovedPayload {
  storeId: string
  productId: string
  variantId: string | null
  warehouseId: string
  type: InventoryMovementType
  quantity: number
}

// The available stock of a product (all its items, all the warehouses of the store) fell to its threshold or under it
// from above (TDD_16 §4.4): once per downward crossing, re-armed when it goes back above
export interface InventoryLowPayload {
  storeId: string
  productId: string
  available: number
  threshold: number
}

// The mark of attention of a conversation changed: `reason` is the new one, null when it was taken off.
// Never the note of the agent: no text crosses the bridge, the client reads the row again.
export interface ConversationAttentionChangedPayload {
  storeId: string
  conversationId: string
  reason: AttentionReason | null
  visibility: ConversationVisibility
}

export interface ConversationReadPayload {
  storeId: string
  conversationId: string
  userId: string
  visibility: ConversationVisibility
}

// A reply an agent wrote, stored and waiting for its channel. Ids and dates only: the text is read
// through the api, which applies who may see the conversation.
export interface MessageQueuedPayload {
  storeId: string
  conversationId: string
  messageId: string
  // Null for what the platform sends by itself (the away reply of the business hours)
  authorId: string | null
  // The idempotency key the client sent: the optimistic bubble of that client matches by it
  clientMessageId: string | null
  createdAt: string // ISO 8601
  visibility: ConversationVisibility
}

// What happened to a reply after it left the queue: the channel took it (sent), the customer's app
// got it (delivered) or showed it (read). Ids only, like the rest.
export interface MessageStatusPayload {
  storeId: string
  conversationId: string
  messageId: string
  visibility: ConversationVisibility
}

// A message edited or deleted. `internal` is a note: only who may read notes hears of it.
export interface MessageChangedPayload extends MessageStatusPayload {
  internal: boolean
}

export interface MessageFailedPayload extends MessageStatusPayload {
  // Always an ErrorCode: what the provider said stays out of the event, the logs and the row
  errorCode: ErrorCode
}

// An internal note, by its ids: the people who hear of a conversation are not all allowed to read
// notes (MESSAGES_INTERNAL_NOTE), so this is for who may
export interface MessageNoteAddedPayload {
  storeId: string
  conversationId: string
  messageId: string
  authorId: string
  createdAt: string
  visibility: ConversationVisibility
}

// One per person mentioned in a note, for that person alone: they were checked to be allowed to
// read the note and to see the conversation
export interface MessageMentionPayload {
  storeId: string
  conversationId: string
  messageId: string
  mentionedUserId: string
  authorId: string
}

export interface CustomerCreatedPayload {
  storeId: string
  customerId: string
}

export interface ProductChangedPayload {
  storeId: string
  productId: string
}

export interface CustomerUpdatedPayload {
  storeId: string
  customerId: string
}

// The merge id is not here: it is what undoes the merge, and whoever hears of it may not undo it
export interface CustomerMergedPayload {
  storeId: string
  survivorId: string
  absorbedId: string
}

export interface CustomerUnmergedPayload {
  storeId: string
  survivorId: string
  absorbedId: string
}

export interface CustomerIdentityLinkedPayload {
  storeId: string
  customerId: string
  identityId: string
  channelType: ChannelId
}

export const ChannelDisconnectedReasons = { USER: 'user', ERROR: 'error' } as const
export type ChannelDisconnectedReason =
  (typeof ChannelDisconnectedReasons)[keyof typeof ChannelDisconnectedReasons]

// The ids are those of the ChannelConnection row (not the provider's connection id)
export interface ChannelConnectedPayload {
  storeId: string
  channelConnectionId: string
  pluginId: ChannelId
}

export interface ChannelDisconnectedPayload {
  storeId: string
  channelConnectionId: string
  pluginId: ChannelId
  // An agent took it down, or its health check failed (the connection may come back by itself)
  reason: ChannelDisconnectedReason
}

// The token of a connection stops working within the warning time (`TokenExpiryLimits.WARN_DAYS`): ids and
// the date, nothing of the token
export interface ChannelTokenExpiringPayload {
  storeId: string
  channelConnectionId: string
  pluginId: ChannelId
  expiresAt: string
}

export interface ChannelHealthRestoredPayload {
  storeId: string
  channelConnectionId: string
  pluginId: ChannelId
}

// Not in the map below: the event is emitted on the bus directly and never written down
export interface CustomerTypingPayload {
  storeId: string
  conversationId: string
}

// An export that settled, ready or failed: ids and the kind only. The file name and the path are read
// from the row when the notification is made, so nothing about the file crosses the bridge.
export interface ExportSettledPayload {
  storeId: string
  exportId: string
  requestedBy: string
  exportType: string
}

// Someone accepted an invitation and is a member now. Ids only; `invitedBy` is who sent the invitation.
export interface MemberJoinedPayload {
  storeId: string
  userId: string
  invitedBy: string
}

// The domain events that are emitted, with the payload of each: DomainEvents.publish takes the name
// and checks the payload against this map

export interface DomainEventPayloads {
  [Events.CHANNEL_CONNECTED]: ChannelConnectedPayload
  [Events.CHANNEL_DISCONNECTED]: ChannelDisconnectedPayload
  [Events.CHANNEL_TOKEN_EXPIRING]: ChannelTokenExpiringPayload
  [Events.CHANNEL_HEALTH_RESTORED]: ChannelHealthRestoredPayload
  [Events.CONVERSATION_CREATED]: ConversationCreatedPayload
  [Events.MESSAGE_RECEIVED]: MessageReceivedPayload
  [Events.CONVERSATION_STATUS_CHANGED]: ConversationStatusChangedPayload
  [Events.CONVERSATION_ASSIGNED]: ConversationAssignedPayload
  [Events.CONVERSATION_SNOOZE_EXPIRED]: ConversationSnoozeExpiredPayload
  [Events.CONVERSATION_REOPENED]: ConversationReopenedPayload
  [Events.CONVERSATION_UNASSIGNED]: ConversationUnassignedPayload
  [Events.MEMBER_JOINED]: MemberJoinedPayload
  [Events.CONVERSATION_READ]: ConversationReadPayload
  [Events.CONVERSATION_ATTENTION_CHANGED]: ConversationAttentionChangedPayload
  [Events.CONVERSATION_UNREAD]: ConversationReadPayload
  [Events.MESSAGE_QUEUED]: MessageQueuedPayload
  [Events.MESSAGE_SENT]: MessageStatusPayload
  [Events.MESSAGE_DELIVERED]: MessageStatusPayload
  [Events.MESSAGE_READ]: MessageStatusPayload
  [Events.MESSAGE_FAILED]: MessageFailedPayload
  [Events.MESSAGE_NOTE_ADDED]: MessageNoteAddedPayload
  [Events.MESSAGE_REACTION]: MessageStatusPayload
  [Events.MESSAGE_EDITED]: MessageChangedPayload
  [Events.MESSAGE_DELETED]: MessageChangedPayload
  [Events.MEDIA_PROCESSED]: MessageChangedPayload
  [Events.MEDIA_INFECTED]: MessageChangedPayload
  [Events.MEDIA_UNSCANNABLE]: MessageChangedPayload
  [Events.MEDIA_UNAVAILABLE]: MessageChangedPayload
  [Events.MESSAGE_MENTION]: MessageMentionPayload
  [Events.EXPORT_READY]: ExportSettledPayload
  [Events.EXPORT_FAILED]: ExportSettledPayload
  [Events.CUSTOMER_CREATED]: CustomerCreatedPayload
  [Events.CUSTOMER_UPDATED]: CustomerUpdatedPayload
  [Events.CUSTOMER_MERGED]: CustomerMergedPayload
  [Events.CUSTOMER_UNMERGED]: CustomerUnmergedPayload
  [Events.CUSTOMER_IDENTITY_LINKED]: CustomerIdentityLinkedPayload
  [Events.ORDER_CREATED]: OrderCreatedPayload
  [Events.ORDER_UPDATED]: OrderEventPayload
  [Events.ORDER_CONFIRMED]: OrderEventPayload
  [Events.ORDER_STATUS_CHANGED]: OrderStatusChangedPayload
  [Events.ORDER_SHIPPED]: OrderEventPayload
  [Events.ORDER_DELIVERED]: OrderEventPayload
  [Events.ORDER_CANCELLED]: OrderEventPayload
  [Events.ORDER_PAYMENT_RECORDED]: OrderPaymentPayload
  [Events.ORDER_PAYMENT_STATUS_CHANGED]: OrderPaymentPayload
  [Events.ORDER_PRICE_OVERRIDDEN]: OrderEventPayload
  [Events.ORDER_PRICE_APPROVAL_REQUESTED]: OrderEventPayload
  [Events.ORDER_PRICE_APPROVED]: OrderEventPayload
  [Events.ORDER_PRICE_REJECTED]: OrderEventPayload
  [Events.ORDER_PACKING_NOTE_CHANGED]: OrderEventPayload
  [Events.INVENTORY_MOVED]: InventoryMovedPayload
  [Events.INVENTORY_LOW]: InventoryLowPayload
  [Events.PRODUCT_CREATED]: ProductChangedPayload
  [Events.PRODUCT_UPDATED]: ProductChangedPayload
  [Events.PRODUCT_DELETED]: ProductChangedPayload
}

// What crosses the bridge from the worker to the api instances: the same payloads with the text taken
// out, because nothing with text leaves the server (the client reads it through the REST api)
export type BridgedPayloads = Omit<
  DomainEventPayloads,
  typeof Events.MESSAGE_RECEIVED | typeof Events.CONVERSATION_CREATED
> & {
  [Events.MESSAGE_RECEIVED]: Omit<MessageReceivedPayload, 'contentPreview'>
  [Events.CONVERSATION_CREATED]: Omit<ConversationCreatedPayload, 'firstMessageContent'>
}
