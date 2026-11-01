import { z } from 'zod'

import type { AuthorType, DeliveryStatus, MediaStatus, MessageType } from '@platform/core/domain'
import {
  AuthorType as AuthorTypes,
  DeliveryStatus as DeliveryStatuses,
  httpUrl,
  InboundLimits,
  MediaStatus as MediaStatuses,
  MessageLimits,
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

// The message a reply answers, as the bubble quotes it: who wrote it, what kind it is and the start
// of its text. A message that was deleted keeps no text here.
export interface QuotedMessage {
  id: string
  type: MessageType
  authorType: AuthorType
  authorId: string | null
  content: string | null
  deleted: boolean
}

export const QUOTE_SELECT = {
  id: true,
  type: true,
  authorType: true,
  authorId: true,
  content: true,
  deletedAt: true
} as const

interface QuoteRow {
  id: string
  type: string
  authorType: string
  authorId: string | null
  content: string | null
  deletedAt: Date | null
}

export function quotedView(row: QuoteRow): QuotedMessage {
  return {
    id: row.id,
    type: enumValueOf(MessageTypes, row.type, 'message type'),
    authorType: enumValueOf(AuthorTypes, row.authorType, 'message author'),
    authorId: row.authorId,
    content: row.deletedAt === null ? previewOf(row.content) : null,
    deleted: row.deletedAt !== null
  }
}

// Counted in characters, as the limits of the channels are, not in UTF-16 units
function previewOf(text: string | null): string | null {
  if (text === null) return null
  const characters = Array.from(text)
  return characters.length <= MessageLimits.QUOTE_PREVIEW_MAX_LENGTH
    ? text
    : characters.slice(0, MessageLimits.QUOTE_PREVIEW_MAX_LENGTH).join('')
}

// The link of what the customer shared (a post, a reel, a story mention, a link preview), as the
// channel sent it. The column is Json, so it is checked again on the way out: only a plain http(s)
// link leaves, and anything else in the metadata is no link.
const attachmentUrlSchema = z.object({ attachmentUrl: httpUrl(InboundLimits.MEDIA_REF_MAX_LENGTH) })

// A file of a message, as the thread lists it: never a link or a key. The signed link is asked from
// `GET /media/:id` when the bubble is drawn, and only once `status` is `clean`.
export interface MessageMediaView {
  id: string
  filename: string
  contentType: string
  fileSize: number
  status: MediaStatus
}

// What the thread shows of a message. The metadata of the channel is not part of it, except the link
// above; a system line carries its own, which is what the thread draws it from.
export interface MessageView {
  id: string
  conversationId: string
  type: MessageType
  content: string | null
  authorType: AuthorType
  authorId: string | null
  replyToMessageId: string | null
  // Filled by the list of a thread, which joins it; null elsewhere and when the original is not in the
  // thread or the reader may not see it
  replyTo: QuotedMessage | null
  deliveryStatus: DeliveryStatus | null
  deliveryError: string | null
  mentions: string[]
  system: SystemLineMetadata | null
  // Untrusted: drawn as a link with its host visible and never fetched by the server. A story mention
  // is a signed link that expires within about a day.
  attachmentUrl: string | null
  reactions: ReactionView[]
  // The files of the message (inbound, or sent with `mediaIds`); empty for a deleted message
  media: MessageMediaView[]
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
  media: {
    select: { id: true, filename: true, contentType: true, fileSize: true, status: true },
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
  media: {
    id: string
    filename: string
    contentType: string
    fileSize: number
    status: string
  }[]
  createdAt: Date
}

export function messageView(row: MessageRow, replyTo: QuotedMessage | null = null): MessageView {
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
    replyTo,
    deliveryStatus:
      row.deliveryStatus === null
        ? null
        : enumValueOf(DeliveryStatuses, row.deliveryStatus, 'delivery status'),
    deliveryError: row.deliveryError,
    mentions: row.mentions,
    // The column is Json: a system line is parsed on the way out, like any other boundary
    system: type === MessageTypes.SYSTEM ? systemLineMetadataSchema.parse(row.metadata) : null,
    attachmentUrl: attachmentUrlOf(row, type),
    reactions: row.reactions.map(reaction => ({
      emoji: reaction.emoji,
      authorType: enumValueOf(AuthorTypes, reaction.authorType, 'reaction author'),
      authorId: reaction.userId ?? reaction.customerIdentityId,
      deliveryStatus: enumValueOf(DeliveryStatuses, reaction.deliveryStatus, 'reaction delivery'),
      deliveryError: reaction.deliveryError
    })),
    // The files of a deleted message are content too
    media:
      row.deletedAt === null
        ? row.media.map(file => ({
            id: file.id,
            filename: file.filename,
            contentType: file.contentType,
            fileSize: file.fileSize,
            status: enumValueOf(MediaStatuses, file.status, 'media status')
          }))
        : [],
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

// A deleted message keeps no content in the thread, and the link it shared is content. A system line
// has its own metadata, which holds no link.
function attachmentUrlOf(row: MessageRow, type: MessageType): string | null {
  if (row.deletedAt !== null || row.metadata === null || type === MessageTypes.SYSTEM) return null
  return attachmentUrlSchema.safeParse(row.metadata).data?.attachmentUrl ?? null
}

const authorOrNull = (text: string | null, what: string): AuthorType | null =>
  text === null ? null : enumValueOf(AuthorTypes, text, what)

const deliveryOrNull = (text: string | null, what: string): DeliveryStatus | null =>
  text === null ? null : enumValueOf(DeliveryStatuses, text, what)
