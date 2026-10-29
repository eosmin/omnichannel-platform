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
  // Edits. `version` is the one an edit of a note must carry. `pendingEdit` is true while the channel has
  // not taken an edit of ours: `content` is still the text the customer has.
  version: number
  editedAt: Date | null
  editedByType: AuthorType | null
  editedById: string | null
  pendingEdit: boolean
  editStatus: DeliveryStatus | null
  editError: string | null
  // Deletion. A deleted message has no `content` here: the thread shows who deleted it and when, and the
  // text, while it is kept, is read with its own permission. `deleteStatus` queued is a deletion of ours
  // that the channel has not taken yet, so the message is still shown.
  deletedAt: Date | null
  deletedByType: AuthorType | null
  deletedById: string | null
  deleteStatus: DeliveryStatus | null
  deleteError: string | null
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
  version: true,
  editedAt: true,
  editedByType: true,
  editedById: true,
  pendingContent: true,
  editStatus: true,
  editError: true,
  deletedAt: true,
  deletedByType: true,
  deletedById: true,
  deleteStatus: true,
  deleteError: true,
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
  version: number
  editedAt: Date | null
  editedByType: string | null
  editedById: string | null
  pendingContent: string | null
  editStatus: string | null
  editError: string | null
  deletedAt: Date | null
  deletedByType: string | null
  deletedById: string | null
  deleteStatus: string | null
  deleteError: string | null
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
    // The text of a deleted message is not part of the thread
    content: row.deletedAt === null ? row.content : null,
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
    version: row.version,
    editedAt: row.editedAt,
    editedByType: authorOrNull(row.editedByType, 'message editor'),
    editedById: row.editedById,
    pendingEdit: row.pendingContent !== null,
    editStatus: deliveryOrNull(row.editStatus, 'edit delivery'),
    editError: row.editError,
    deletedAt: row.deletedAt,
    deletedByType: authorOrNull(row.deletedByType, 'message deleter'),
    deletedById: row.deletedById,
    deleteStatus: deliveryOrNull(row.deleteStatus, 'delete delivery'),
    deleteError: row.deleteError,
    createdAt: row.createdAt
  }
}

const authorOrNull = (text: string | null, what: string): AuthorType | null =>
  text === null ? null : enumValueOf(AuthorTypes, text, what)

const deliveryOrNull = (text: string | null, what: string): DeliveryStatus | null =>
  text === null ? null : enumValueOf(DeliveryStatuses, text, what)
