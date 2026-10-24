import type {
  AuthorType,
  BulkLabelJobStatus,
  ChannelType,
  ConversationStatus,
  OrderStatus,
  ShipmentStatus
} from '@platform/core/domain'
import type { ErrorCode } from '@platform/core/errors'
import type { NotificationRealtimePayload } from '@platform/core/notifications'

// Separate from the domain events: these are what the browser subscribes to.
export const RealtimeEvents = {
  // Server -> client
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_UPDATED: 'conversation.updated',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_STATUS_CHANGED: 'conversation.status_changed',
  CONVERSATION_READ: 'conversation.read',

  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_FAILED: 'message.failed',

  TYPING_START: 'typing.start',
  TYPING_STOP: 'typing.stop',
  CUSTOMER_TYPING: 'customer.typing',

  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',

  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',

  SHIPMENT_UPDATED: 'shipment.updated',
  BULK_LABELS_PROGRESS: 'bulk_labels.progress',
  BULK_LABELS_DONE: 'bulk_labels.done',

  NOTIFICATION: 'notification',

  // Client -> server
  HEARTBEAT: 'heartbeat',
  JOIN_CONVERSATION: 'conversation.join',
  LEAVE_CONVERSATION: 'conversation.leave',

  // Server -> client, connection-level
  AUTH_ERROR: 'auth.error'
} as const

export type RealtimeEvent = (typeof RealtimeEvents)[keyof typeof RealtimeEvents]

// Typed payload map: every event in RealtimeEvents has an entry here. A missing entry is a
// compile error (RealtimeEventMapIsComplete below, and RealtimeService in TDD_06 §1.5).
export interface RealtimeEventMap {
  [RealtimeEvents.CONVERSATION_CREATED]: {
    conversationId: string
    customerId: string
    channelType: ChannelType
  }
  [RealtimeEvents.CONVERSATION_UPDATED]: {
    conversationId: string
    status: ConversationStatus
    assignedTo: string | null
    lastMessageAt: string | null
  }
  [RealtimeEvents.CONVERSATION_ASSIGNED]: {
    conversationId: string
    assignedTo: string | null
    assignedBy: string | null
  }
  [RealtimeEvents.CONVERSATION_STATUS_CHANGED]: {
    conversationId: string
    status: ConversationStatus
    previousStatus: ConversationStatus
  }
  [RealtimeEvents.CONVERSATION_READ]: { conversationId: string; userId: string }

  [RealtimeEvents.MESSAGE_RECEIVED]: {
    conversationId: string
    messageId: string
    authorType: AuthorType
    contentPreview: string | null
    createdAt: string
  }
  [RealtimeEvents.MESSAGE_SENT]: {
    conversationId: string
    messageId: string
    clientMessageId: string | null
  }
  [RealtimeEvents.MESSAGE_DELIVERED]: { conversationId: string; messageId: string }
  [RealtimeEvents.MESSAGE_READ]: { conversationId: string; messageId: string }
  [RealtimeEvents.MESSAGE_FAILED]: {
    conversationId: string
    messageId: string
    errorCode: ErrorCode
  }

  [RealtimeEvents.TYPING_START]: { conversationId: string; userId: string; userName: string }
  [RealtimeEvents.TYPING_STOP]: { conversationId: string; userId: string }
  [RealtimeEvents.CUSTOMER_TYPING]: { conversationId: string }

  [RealtimeEvents.USER_ONLINE]: { userId: string }
  [RealtimeEvents.USER_OFFLINE]: { userId: string }

  [RealtimeEvents.ORDER_CREATED]: {
    orderId: string
    conversationId: string | null
    customerId: string
  }
  [RealtimeEvents.ORDER_UPDATED]: { orderId: string; status: OrderStatus }

  [RealtimeEvents.SHIPMENT_UPDATED]: {
    orderId: string
    shipmentId: string
    status: ShipmentStatus
  }
  [RealtimeEvents.BULK_LABELS_PROGRESS]: {
    jobId: string
    done: number
    total: number
    failed: number
  }
  [RealtimeEvents.BULK_LABELS_DONE]: {
    jobId: string
    status: BulkLabelJobStatus
    mergedMediaId: string | null
  }

  [RealtimeEvents.NOTIFICATION]: NotificationRealtimePayload

  [RealtimeEvents.HEARTBEAT]: Record<string, never>
  [RealtimeEvents.JOIN_CONVERSATION]: { conversationId: string }
  [RealtimeEvents.LEAVE_CONVERSATION]: { conversationId: string }

  [RealtimeEvents.AUTH_ERROR]: { code: ErrorCode }
}

// Compile-time guard in both directions: it resolves to `never`, and the assignment below stops
// compiling, when RealtimeEvents gains a key RealtimeEventMap lacks or the other way around.
export type AssertRealtimeMapComplete = [RealtimeEvent] extends [keyof RealtimeEventMap]
  ? [keyof RealtimeEventMap] extends [RealtimeEvent]
    ? true
    : never
  : never

export const realtimeEventMapIsComplete: AssertRealtimeMapComplete = true
