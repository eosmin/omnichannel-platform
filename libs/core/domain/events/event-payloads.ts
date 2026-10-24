import type { AuthorType, ChannelType, ConversationStatus, InventoryMovementType } from '../index'

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
  channelType: ChannelType
  authorType: AuthorType
  contentPreview: string | null // First 200 chars, for listeners that only need a glance
  receivedAt: string // ISO 8601
}

export interface ConversationCreatedPayload {
  storeId: string
  conversationId: string
  customerId: string
  channelType: ChannelType
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

export interface ConversationAssignedPayload {
  storeId: string
  conversationId: string
  assignedTo: string | null
  previousAssignee: string | null
  assignedBy: ActorRef
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
