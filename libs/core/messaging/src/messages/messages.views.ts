import type { AuthorType, DeliveryStatus, MessageType } from '@platform/core/domain'
import {
  AuthorType as AuthorTypes,
  DeliveryStatus as DeliveryStatuses,
  MessageType as MessageTypes
} from '@platform/core/domain'

import { enumValueOf } from '../conversations/conversations.support'
import { type SystemLineMetadata, systemLineMetadataSchema } from '../conversations/system-lines'

// One person's emoji on a message. `authorId` is the user for an agent, the customer identity for the
// customer, and null for the owner who reacted from the provider's own app.
export interface ReactionView {
  emoji: string
  authorType: AuthorType
  authorId: string | null
  // Where an agent's reaction stands toward the channel; `failed` says the customer never saw it, with
  // the code of ours in `deliveryError`. The ones the channel reported are `sent`.
  deliveryStatus: DeliveryStatus
  deliveryError: string | null
}

// What the thread shows of a message. The metadata of the channel is not part of it; a system line
// carries its own, which is what the thread draws it from.
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
  system: SystemLineMetadata | null
  reactions: ReactionView[]
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
  metadata: true,
  reactions: {
    select: {
      emoji: true,
      authorType: true,
      customerIdentityId: true,
      userId: true,
      deliveryStatus: true,
      deliveryError: true
    },
    orderBy: { createdAt: 'asc' }
  },
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
  metadata: unknown
  reactions: {
    emoji: string
    authorType: string
    customerIdentityId: string | null
    userId: string | null
    deliveryStatus: string
    deliveryError: string | null
  }[]
  createdAt: Date
}

export function messageView(row: MessageRow): MessageView {
  const type = enumValueOf(MessageTypes, row.type, 'message type')
  return {
    id: row.id,
    conversationId: row.conversationId,
    type,
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
    // The column is Json: a system line is parsed on the way out, like any other boundary
    system: type === MessageTypes.SYSTEM ? systemLineMetadataSchema.parse(row.metadata) : null,
    reactions: row.reactions.map(reaction => ({
      emoji: reaction.emoji,
      authorType: enumValueOf(AuthorTypes, reaction.authorType, 'reaction author'),
      authorId: reaction.userId ?? reaction.customerIdentityId,
      deliveryStatus: enumValueOf(DeliveryStatuses, reaction.deliveryStatus, 'reaction delivery'),
      deliveryError: reaction.deliveryError
    })),
    createdAt: row.createdAt
  }
}
