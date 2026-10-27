import type { AuthorType, ChannelId, ConversationStatus, InventoryMovementType } from '../index'

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
}

export interface ConversationCreatedPayload {
  storeId: string
  conversationId: string
  customerId: string
  channelType: ChannelId
  firstMessageId: string // Emitted after the first message is persisted, never before
  firstMessageContent: string | null
}

export interface ConversationStatusChangedPayload {
  storeId: string
  conversationId: string
  previousStatus: ConversationStatus
  status: ConversationStatus
  assignedTo: string | null
  changedBy: ActorRef
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

export interface OrderCreatedPayload {
  storeId: string
  orderId: string
  orderNumber: string
  customerId: string
  conversationId: string | null
  totalCents: number
  currency: string
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
  authorId: string
  createdAt: string // ISO 8601
  visibility: ConversationVisibility
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

// The domain events that are emitted, with the payload of each: DomainEvents.publish takes the name
// and checks the payload against this map
export interface DomainEventPayloads {
  [Events.CONVERSATION_CREATED]: ConversationCreatedPayload
  [Events.MESSAGE_RECEIVED]: MessageReceivedPayload
  [Events.CONVERSATION_STATUS_CHANGED]: ConversationStatusChangedPayload
  [Events.CONVERSATION_ASSIGNED]: ConversationAssignedPayload
  [Events.CONVERSATION_READ]: ConversationReadPayload
  [Events.MESSAGE_QUEUED]: MessageQueuedPayload
  [Events.MESSAGE_NOTE_ADDED]: MessageNoteAddedPayload
  [Events.MESSAGE_MENTION]: MessageMentionPayload
  [Events.CUSTOMER_CREATED]: CustomerCreatedPayload
  [Events.CUSTOMER_UPDATED]: CustomerUpdatedPayload
  [Events.CUSTOMER_MERGED]: CustomerMergedPayload
  [Events.CUSTOMER_UNMERGED]: CustomerUnmergedPayload
  [Events.CUSTOMER_IDENTITY_LINKED]: CustomerIdentityLinkedPayload
}
