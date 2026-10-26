import type { AuthorType, DeliveryStatus, MessageType } from '@platform/core/domain'
import {
  AuthorType as AuthorTypes,
  DeliveryStatus as DeliveryStatuses,
  MessageType as MessageTypes
} from '@platform/core/domain'

import { enumValueOf } from '../conversations'

// What the thread shows of a message. The metadata of the channel is not part of it.
export interface MessageView {
  id: string
  conversationId: string
  type: MessageType
  content: string | null
  authorType: AuthorType
  authorId: string | null
  replyToMessageId: string | null
  deliveryStatus: DeliveryStatus | null
  deliveryError: string | null
  mentions: string[]
  createdAt: Date
}

export const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  type: true,
  content: true,
  authorType: true,
  authorId: true,
  replyToMessageId: true,
  deliveryStatus: true,
  deliveryError: true,
  mentions: true,
  createdAt: true
} as const

interface MessageRow {
  id: string
  conversationId: string
  type: string
  content: string | null
  authorType: string
  authorId: string | null
  replyToMessageId: string | null
  deliveryStatus: string | null
  deliveryError: string | null
  mentions: string[]
  createdAt: Date
}

export function messageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    type: enumValueOf(MessageTypes, row.type, 'message type'),
    content: row.content,
    authorType: enumValueOf(AuthorTypes, row.authorType, 'message author'),
    authorId: row.authorId,
    replyToMessageId: row.replyToMessageId,
    deliveryStatus:
      row.deliveryStatus === null
        ? null
        : enumValueOf(DeliveryStatuses, row.deliveryStatus, 'delivery status'),
    deliveryError: row.deliveryError,
    mentions: row.mentions,
    createdAt: row.createdAt
  }
}
