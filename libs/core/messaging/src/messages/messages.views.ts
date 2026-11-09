import { z } from 'zod'

import type {
  AuthorType,
  CaptionState,
  ContactCard,
  DeliveryStatus,
  MediaStatus,
  MediaUnavailableCode,
  MessageType
} from '@platform/core/domain'
import {
  AuthorType as AuthorTypes,
  DeliveryStatus as DeliveryStatuses,
  httpUrl,
  InboundLimits,
  MediaStatus as MediaStatuses,
  CaptionState as CaptionStates,
  MessageLimits,
  MessageMetadataKeys,
  MessageType as MessageTypes,
  placeTextOf,
  sanitizeContactCards,
  UNAVAILABLE_FILES_KEY
} from '@platform/core/domain'

import { enumValueOf } from '../conversations/conversations.support'
import { type SystemLineMetadata, systemLineMetadataSchema } from '../conversations/system-lines'

import { canRetryLostFile, displayCodeOf, lostFilesSchema } from './lost-files'
import { isDistinctFile, isNativeAlbum } from './provider-message-match'

// One person's emoji on a message. `authorId` is the user for an agent, the customer identity for the
// customer, and null for the owner who reacted from the provider's own app.
export interface ReactionView {
  emoji: string
  authorType: AuthorType
  authorId: string | null
  // The file of an album the reaction is under (one reaction for each person and file); null: the message itself
  mediaId: string | null
  // The file to draw it under, already resolved: `mediaId`, or the first file when the reaction is the message's and
  // the message IS the first file (one message for each picture). Null: the reaction is the message's (a native album,
  // a message of one file)
  fileId: string | null
  // Where an agent's reaction stands toward the channel; `failed` says the customer never saw it, with
  // the code of ours in `deliveryError`. The ones the channel reported are `sent`.
  deliveryStatus: DeliveryStatus
  deliveryError: string | null
}

// The message a reply answers, as the bubble quotes it: who wrote it, what kind it is and the start
// of its text. A message that was deleted keeps no text here.
// The order the agent gave the files; the files of the customer have no place and keep their arrival order
// (a mutable array: Prisma does not take a readonly one)
const MEDIA_ORDER: (
  { position: { sort: 'asc'; nulls: 'last' } } | { createdAt: 'asc' } | { id: 'asc' }
)[] = [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }]

// The file of an album that a reply quotes: which one, and where it is in the message (the place the agent gave it,
// else its order, from 0, for the files of a customer that have none)
export interface QuotedFile {
  mediaId: string
  position: number
}

export interface QuotedMessage {
  id: string
  type: MessageType
  authorType: AuthorType
  authorId: string | null
  content: string | null
  deleted: boolean
  // The file that was quoted when the reply named one of a message of several; null: the message as a whole
  file: QuotedFile | null
}

export const QUOTE_SELECT = {
  id: true,
  storeId: true,
  // To place a quoted file in its message
  media: {
    select: { id: true, storeId: true, position: true, channelMessageId: true },
    orderBy: MEDIA_ORDER
  },
  type: true,
  authorType: true,
  authorId: true,
  content: true,
  deletedAt: true
} as const

export interface QuoteRow {
  id: string
  storeId: string
  media: {
    id: string
    storeId: string | null
    position: number | null
    channelMessageId: string | null
  }[]
  type: string
  authorType: string
  authorId: string | null
  content: string | null
  deletedAt: Date | null
}

// The file of the quoted message that the reply names, placed by its position or its order. A file that is not of
// this message and store, or that is gone, is no file: the quote is the message.
function quotedFileOf(row: QuoteRow, mediaId: string | null): QuotedFile | null {
  if (mediaId === null) return null
  const files = row.media.filter(file => file.storeId === row.storeId)
  const index = files.findIndex(file => file.id === mediaId)
  const file = files[index]
  // Only a file the provider still tells apart is placed: if the album turned out to be one message (the files share
  // an id), the quote is the message, as the provider took it
  if (file === undefined || !isDistinctFile(files, file)) return null
  return { mediaId, position: file.position ?? index }
}

export function quotedView(row: QuoteRow, replyToMediaId: string | null = null): QuotedMessage {
  return {
    file: row.deletedAt === null ? quotedFileOf(row, replyToMediaId) : null,
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

// The story of the business that the customer answered (`MessageMetadataKeys.STORY_REPLY`): `{ url? }`. Checked
// again on the way out like the link above: a link that is not plain http(s), or too long, is no link, but the
// reply still was one to a story.
const storyReplySchema = z.object({
  [MessageMetadataKeys.STORY_REPLY]: z.object({
    url: httpUrl(InboundLimits.MEDIA_REF_MAX_LENGTH).optional().catch(undefined)
  })
})

// The provider's name for a type a channel could not read, kept beside the `[name]` text it stored for
// it. Only a plain name leaves (what the channel plugins accept), so nothing else of the metadata does.
const providerTypeSchema = z.object({
  [MessageMetadataKeys.UNSUPPORTED_TYPE]: z.string().regex(/^[A-Za-z0-9_]{1,64}$/)
})

// A file of a message, as the thread lists it: never a link or a key. The signed link is asked from
// `GET /media/:id` when the bubble is drawn, and only once `status` is `clean`.
export interface MessageMediaView {
  id: string
  filename: string
  contentType: string
  fileSize: number
  status: MediaStatus
  // The place of the file in a message an agent sent, from 0; null for a file the customer sent
  position: number | null
  // How the channel took this file: null for a file the customer sent, or one sent before each had its own
  // state (the state of the message is then theirs). Never the provider's id.
  delivery: DeliveryStatus | null
  // Our code for why this file did not go; null unless `delivery` is failed
  errorCode: string | null
  // The text the agent put under this file; null when none, and for a file sent before each had its own
  // (the text of the message is then the one of the first). Text of the agent: drawn escaped.
  caption: string | null
  // The provider has an id of its own for this file, so a reaction or a quote can name it alone: true for each file of
  // a message with one message at the provider for each (WhatsApp), false when the files share one id (a native album
  // of Instagram or Messenger) and for a file with no id yet
  targetable: boolean
}

// A file the customer sent that the platform could not keep: where it was in the message and why. The
// worker writes it when it gives up, so a file still being fetched is not in the list.
export interface UnavailableFileView {
  index: number
  code: MediaUnavailableCode
  // An agent may ask for the file again (`POST /messages/:id/files/:index/refetch`)
  canRetry: boolean
}

// The place a customer shared. The coordinates are checked here, so the thread never builds a map link
// from anything else; the name and the address are text of the customer, cut and shown as plain text.
export interface LocationView {
  latitude: number
  longitude: number
  name: string | null
  address: string | null
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
  // The file of an album that the reply quotes; null: the message
  replyToMediaId: string | null
  // Filled by the list of a thread, which joins it; null elsewhere and when the original is not in the
  // thread or the reader may not see it
  replyTo: QuotedMessage | null
  deliveryStatus: DeliveryStatus | null
  deliveryError: string | null
  // Only for a reply that failed: true when the channel is known not to have taken it (it can be sent again
  // or thrown away: `POST /messages/:id/discard`), false or null when it may have (sending it again may
  // repeat it, and it cannot be thrown away). Null for anything that has not failed.
  failureDefinitive: boolean | null
  mentions: string[]
  system: SystemLineMetadata | null
  // The place of a location message, or null (not a location, deleted, or coordinates that do not hold)
  location: LocationView | null
  // The contact cards a customer shared (a CONTACTS message), cleaned and bounded; null for any other message, a
  // deleted one, or cards that do not hold
  contacts: ContactCard[] | null
  // An image the customer sent as a sticker: the thread draws it without a bubble
  sticker: boolean
  // Untrusted: drawn as a link with its host visible and never fetched by the server. A story mention
  // is a signed link that expires within about a day.
  attachmentUrl: string | null
  // The message answers a story of the business: the link of it (untrusted, it expires within about a day, and
  // it may not come: null) or null when it does not answer one
  storyReply: { url: string | null } | null
  // The type a channel could not read when `content` is only its `[type]` marker (English, the provider's
  // name): the thread writes its own translated sentence instead of drawing it. Null for any real text.
  unsupportedType: string | null
  reactions: ReactionView[]
  // The files of the message (inbound, or sent with `mediaIds`); empty for a deleted message
  media: MessageMediaView[]
  // Files of the customer that could not be kept; empty for a deleted message
  unavailableFiles: UnavailableFileView[]
  // The state of the text under a file that went apart from it (Instagram and Messenger): failed, or
  // unconfirmed when the provider may have delivered it; null when there is nothing to say
  captionState: CaptionState | null
  // The text of the message (`content`) is a message of its own after the files, not the text under the first one
  textApart: boolean
  // The provider took the files as ONE message (a native album of Instagram or Messenger): its files share one id,
  // so they cannot be reacted to or quoted one by one. Derived from the ids, not from the channel.
  albumNative: boolean
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
  replyToMediaId: true,
  // Not in the view: the provider's ids decide what the view says of the files (`targetable`, `albumNative`)
  channelMessageId: true,
  deliveryStatus: true,
  deliveryError: true,
  failureDefinitive: true,
  mentions: true,
  metadata: true,
  captionState: true,
  textApart: true,
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
      mediaId: true,
      deliveryStatus: true,
      deliveryError: true
    },
    orderBy: { createdAt: 'asc' }
  },
  media: {
    select: {
      id: true,
      filename: true,
      contentType: true,
      fileSize: true,
      status: true,
      position: true,
      deliveryStatus: true,
      sendErrorCode: true,
      caption: true,
      channelMessageId: true
    },
    // The order the agent gave; the files of the customer have no place and keep their arrival order
    orderBy: MEDIA_ORDER
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
  replyToMediaId: string | null
  channelMessageId: string | null
  deliveryStatus: string | null
  deliveryError: string | null
  failureDefinitive: boolean | null
  mentions: string[]
  metadata: unknown
  captionState: string | null
  textApart: boolean
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
    mediaId: string | null
    deliveryStatus: string
    deliveryError: string | null
  }[]
  media: {
    id: string
    filename: string
    contentType: string
    fileSize: number
    status: string
    position: number | null
    deliveryStatus: string | null
    sendErrorCode: string | null
    caption: string | null
    channelMessageId: string | null
  }[]
  createdAt: Date
}

// The file a reaction is drawn under. The one it was put under, or, when it is the message's and the message IS the
// first file of one message for each picture, that file; none in a native album or for a message of one file.
function reactionFileOf(row: MessageRow, mediaId: string | null): string | null {
  if (mediaId !== null) return mediaId
  if (row.deletedAt !== null || row.channelMessageId === null) return null
  const first = row.media.find(file => file.channelMessageId === row.channelMessageId)
  return first !== undefined && isDistinctFile(row.media, first) ? first.id : null
}

function editFieldsOf(
  row: MessageRow
): Pick<
  MessageView,
  'editedAt' | 'editedByType' | 'editedById' | 'pendingEdit' | 'editStatus' | 'editError'
> {
  if (row.deletedAt !== null) {
    return {
      editedAt: null,
      editedByType: null,
      editedById: null,
      pendingEdit: false,
      editStatus: null,
      editError: null
    }
  }
  return {
    editedAt: row.editedAt,
    editedByType: authorOrNull(row.editedByType, 'message editor'),
    editedById: row.editedById,
    pendingEdit: row.pendingContent !== null,
    editStatus: deliveryOrNull(row.editStatus, 'edit delivery'),
    editError: row.editError
  }
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
    replyToMediaId: row.replyToMediaId,
    replyTo,
    deliveryStatus:
      row.deliveryStatus === null
        ? null
        : enumValueOf(DeliveryStatuses, row.deliveryStatus, 'delivery status'),
    deliveryError: row.deliveryError,
    failureDefinitive: row.failureDefinitive,
    mentions: row.mentions,
    // The column is Json: a system line is parsed on the way out, like any other boundary
    system: type === MessageTypes.SYSTEM ? systemLineMetadataSchema.parse(row.metadata) : null,
    location: locationOf(row, type),
    contacts: contactsOf(row, type),
    sticker: stickerOf(row, type),
    attachmentUrl: attachmentUrlOf(row, type),
    storyReply: storyReplyOf(row, type),
    unsupportedType: unsupportedTypeOf(row, type),
    reactions: row.reactions.map(reaction => ({
      fileId: reactionFileOf(row, reaction.mediaId),
      emoji: reaction.emoji,
      authorType: enumValueOf(AuthorTypes, reaction.authorType, 'reaction author'),
      authorId: reaction.userId ?? reaction.customerIdentityId,
      mediaId: reaction.mediaId,
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
            status: enumValueOf(MediaStatuses, file.status, 'media status'),
            position: file.position,
            delivery:
              file.deliveryStatus === null
                ? null
                : enumValueOf(DeliveryStatuses, file.deliveryStatus, 'media delivery'),
            errorCode: file.sendErrorCode,
            // The text under the first file is the text of the message (what an edit settles, and what a
            // message sent before each file had its own carries)
            caption: file.position === 0 && !row.textApart ? row.content : file.caption,
            targetable: isDistinctFile(row.media, file)
          }))
        : [],
    unavailableFiles: unavailableFilesOf(row, type),
    captionState: row.deletedAt === null ? captionStateOf(row.captionState) : null,
    textApart: row.textApart,
    albumNative: row.deletedAt === null && isNativeAlbum(row.media),
    version: row.version,
    // A message edited and then deleted is a deleted message: the deletion wins, so it carries no
    // "edited", no editor and no edit waiting or failed (its text is already hidden above)
    ...editFieldsOf(row),
    deletedAt: row.deletedAt,
    deletedByType: authorOrNull(row.deletedByType, 'message deleter'),
    deletedById: row.deletedById,
    deleteStatus: deliveryOrNull(row.deleteStatus, 'delete delivery'),
    deleteError: row.deleteError,
    createdAt: row.createdAt
  }
}

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().optional().catch(undefined),
  address: z.string().optional().catch(undefined)
})

// The cards of a shared contact, read again here though the channel already bounded them: the metadata is a
// column anyone with the database could have written, and the thread draws it as it comes. The same cleaning
// and caps as the channel's (`sanitizeContactCards`), one card at a time. A deleted message keeps none.
function contactsOf(row: MessageRow, type: MessageType): ContactCard[] | null {
  if (type !== MessageTypes.CONTACTS || row.deletedAt !== null) return null
  const metadata = row.metadata
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const cards = sanitizeContactCards(
    (metadata as Record<string, unknown>)[MessageMetadataKeys.CONTACTS]
  )
  return cards.length === 0 ? null : cards
}

const stickerSchema = z.object({ [MessageMetadataKeys.STICKER]: z.literal(true) })

// Only an image that is still there: a deleted sticker is a deleted message like any other
function stickerOf(row: MessageRow, type: MessageType): boolean {
  if (type !== MessageTypes.IMAGE || row.deletedAt !== null) return false
  return stickerSchema.safeParse(row.metadata).success
}

// A deleted message keeps no content in the thread, and the place it shared is content
function locationOf(row: MessageRow, type: MessageType): LocationView | null {
  if (type !== MessageTypes.LOCATION || row.deletedAt !== null) return null
  const parsed = locationSchema.safeParse(row.metadata)
  if (!parsed.success) return null
  return {
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
    name: placeTextOf(parsed.data.name),
    address: placeTextOf(parsed.data.address)
  }
}

// A deleted message keeps no content in the thread, and the link it shared is content. A system line
// has its own metadata, which holds no link.
function attachmentUrlOf(row: MessageRow, type: MessageType): string | null {
  if (row.deletedAt !== null || row.metadata === null || type === MessageTypes.SYSTEM) return null
  return attachmentUrlSchema.safeParse(row.metadata).data?.attachmentUrl ?? null
}

function storyReplyOf(row: MessageRow, type: MessageType): { url: string | null } | null {
  // Only what a customer sent: not a deleted message, a system line or an internal note
  if (row.deletedAt !== null || row.metadata === null) return null
  if (type === MessageTypes.SYSTEM || type === MessageTypes.INTERNAL_NOTE) return null
  const story = storyReplySchema.safeParse(row.metadata).data?.[MessageMetadataKeys.STORY_REPLY]
  return story === undefined ? null : { url: story.url ?? null }
}

// The channel marks the message when its whole text is the marker `[name]` for a type it cannot read; a
// customer who types the same words, or shares a link and types them, has no such mark
function unsupportedTypeOf(row: MessageRow, type: MessageType): string | null {
  if (row.deletedAt !== null || row.metadata === null || type !== MessageTypes.TEXT) return null
  const name = providerTypeSchema.safeParse(row.metadata).data?.[
    MessageMetadataKeys.UNSUPPORTED_TYPE
  ]
  return name !== undefined && row.content === `[${name}]` ? name : null
}

// Same rule as the link: a deleted message and a system line show none
function unavailableFilesOf(row: MessageRow, type: MessageType): UnavailableFileView[] {
  if (row.deletedAt !== null || row.metadata === null || type === MessageTypes.SYSTEM) return []
  const entries = lostFilesSchema.safeParse(row.metadata).data?.[UNAVAILABLE_FILES_KEY] ?? []
  return entries.map(entry => ({
    index: entry.index,
    code: displayCodeOf(entry.code),
    canRetry: canRetryLostFile(entry)
  }))
}

// A state this version does not know (written by a newer one) says nothing rather than failing the thread
const KNOWN_CAPTION_STATES: readonly CaptionState[] = Object.values(CaptionStates)
function captionStateOf(text: string | null): CaptionState | null {
  return KNOWN_CAPTION_STATES.find(state => state === text) ?? null
}

const authorOrNull = (text: string | null, what: string): AuthorType | null =>
  text === null ? null : enumValueOf(AuthorTypes, text, what)

const deliveryOrNull = (text: string | null, what: string): DeliveryStatus | null =>
  text === null ? null : enumValueOf(DeliveryStatuses, text, what)
