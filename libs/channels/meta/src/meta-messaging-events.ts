import {
  httpUrl,
  InboundLimits,
  isWholeEmoji,
  MessageMetadataKeys,
  MessageType,
  MetaGraph,
  MetaMessaging,
  OriginKinds,
  OriginMediaTypes,
  placeTextOf,
  ReactionActors,
  UnsupportedShapeLimits
} from '@platform/core/domain'
import { type ChannelEvent, ChannelEventTypes, type ChannelOrigin } from '@platform/plugins/sdk'

import { cut, hasText, replyTarget } from './inbound-text'
import {
  metaAttachmentRawLinkSchema,
  metaAttachmentSchema,
  type MetaMessageEdit,
  type MetaMessage,
  type MetaMessagingItem,
  metaReferralSchema,
  metaWebhookSchema,
  parseMessagingEntry,
  parseMessagingItem
} from './meta-messaging.schema'

type ReceivedMessage = NonNullable<ChannelEvent['message']>

// A Map and not an object: the type is a string of the sender's choosing, and 'constructor' or
// '__proto__' must not find a key in Object.prototype
const MEDIA_ATTACHMENTS: ReadonlyMap<string, MessageType> = new Map([
  ['image', MessageType.IMAGE],
  ['video', MessageType.VIDEO],
  ['audio', MessageType.AUDIO],
  ['file', MessageType.DOCUMENT],
  // A sticker is an image the customer sent
  ['sticker', MessageType.IMAGE]
])

// The name of a type goes into the visible content: letters, digits and underscore only
const PROVIDER_TYPE = /^[A-Za-z0-9_]{1,64}$/
const UNSUPPORTED_TYPE = 'unsupported'
const URL_SCHEMA = httpUrl(InboundLimits.MEDIA_REF_MAX_LENGTH)

// The creative of the ad: the links Meta sends
function originMedia(photo: string | undefined, video: string | undefined): ChannelOrigin['media'] {
  if (video) return { type: OriginMediaTypes.VIDEO, url: video }
  if (photo) return { type: OriginMediaTypes.IMAGE, url: photo }
  return undefined
}

// The ad (or the m.me link) the customer came through. Nothing here can cost the message: a part that
// does not fit is left out, and the raw referral is kept only while it fits a metadata object.
function originOf(raw: Record<string, unknown> | undefined): ChannelOrigin | undefined {
  if (raw === undefined || Object.keys(raw).length === 0) return undefined
  const parsed = metaReferralSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const referral = parsed.data
  const context = referral.ads_context_data
  const title = context?.ad_title
  const isAd = referral.source === MetaMessaging.REFERRAL_SOURCE_ADS || referral.ad_id !== undefined
  const media = originMedia(context?.photo_url, context?.video_url)
  // A link in `source` is the m.me or ig.me link that was tapped
  const sourceUrl = URL_SCHEMA.safeParse(referral.source)
  return {
    kind: isAd ? OriginKinds.AD : OriginKinds.OTHER,
    ...(referral.ad_id ? { sourceId: referral.ad_id } : {}),
    ...(sourceUrl.success ? { sourceUrl: sourceUrl.data } : {}),
    ...(hasText(title) ? { title: cut(title, InboundLimits.ORIGIN_TITLE_MAX_LENGTH) } : {}),
    ...(media ? { media } : {}),
    ...(Buffer.byteLength(JSON.stringify(raw)) <= InboundLimits.METADATA_MAX_BYTES
      ? { referral: raw }
      : {})
  }
}

interface ParsedAttachment {
  type: string
  url: string | undefined
  title: string | undefined
  stickerId: string | undefined
  coordinates: { lat: number; long: number } | undefined
  // The link as it came, when it did not pass as one: a file is still a file (MS-04)
  rawUrl: string | undefined
}

// Each attachment is read once; one that does not have the shape is the same as one that is not there
function parseAttachments(raw: unknown[]): ParsedAttachment[] {
  return raw.flatMap(item => {
    const attachment = metaAttachmentSchema.safeParse(item)
    if (!attachment.success) return []
    const url = attachment.data.payload?.url
    const rawUrl =
      url === undefined ? metaAttachmentRawLinkSchema.parse(item).payload?.url : undefined
    const { title, payload } = attachment.data
    return [
      {
        type: attachment.data.type,
        url,
        title,
        stickerId: payload?.sticker_id,
        coordinates: payload?.coordinates,
        rawUrl
      }
    ]
  })
}

// The files of a message, with the url Meta put in the webhook as the reference to fetch them
function mediaOf(attachments: ParsedAttachment[]): {
  type: MessageType
  media: NonNullable<ReceivedMessage['media']>
} | null {
  const media: NonNullable<ReceivedMessage['media']>[number][] = []
  const seen = new Set<string>()
  let type: MessageType | undefined
  for (const { type: attachmentType, url: checked, rawUrl } of attachments) {
    const kind = MEDIA_ATTACHMENTS.get(attachmentType)
    // A link that is not a public web address is not dropped: the worker refuses it with the notice
    const url = checked ?? rawUrl
    if (!kind || !url) continue
    // A sticker comes with an image of the same link (Meta sends both until 2026-08-30): one file
    if (seen.has(url)) continue
    seen.add(url)
    type ??= kind
    // Meta does not say the type of the file in the webhook: the fetch reads it from the file. An
    // audio is a clip in an mp4 container, and the hint lets the fetch keep it as audio when the
    // server of the file calls it video/mp4.
    media.push({
      ref: url,
      contentType:
        kind === MessageType.AUDIO
          ? MetaGraph.AUDIO_HINT_CONTENT_TYPE
          : MetaGraph.FALLBACK_CONTENT_TYPE,
      filename: null
    })
    if (media.length === InboundLimits.MAX_MEDIA_PER_MESSAGE) break
  }
  return type ? { type, media } : null
}

// The attachment that is not a file (a shared post, a reel, a story mention): its type and, when
// there is one, its link, so the team can open what the customer shared
function sharedOf(attachments: ParsedAttachment[]): ParsedAttachment | null {
  let first: ParsedAttachment | null = null
  for (const shared of attachments) {
    // A file with a link is already read as media: it is not what the customer shared
    if (shared.url && MEDIA_ATTACHMENTS.has(shared.type)) continue
    // One with a link is the one the team can open; a file with none comes second
    if (shared.url) return shared
    first ??= shared
  }
  return first
}

// Whether every file of the message is a sticker: an attachment with a sticker id (Messenger sends them
// as an image or a sticker) or of the type sticker. A photo beside a sticker keeps the message a photo.
function isStickerOnly(
  attachments: ParsedAttachment[],
  media: NonNullable<ReceivedMessage['media']>
): boolean {
  const stickers = new Set(
    attachments
      .filter(
        item => item.stickerId !== undefined || item.type === MetaMessaging.ATTACHMENT_STICKER
      )
      .map(item => item.url ?? item.rawUrl)
  )
  return media.length > 0 && media.every(file => stickers.has(file.ref))
}

function likeOf(attachments: ParsedAttachment[]): ParsedAttachment | undefined {
  return attachments.find(
    attachment =>
      attachment.stickerId !== undefined &&
      MetaMessaging.LIKE_STICKER_IDS.includes(attachment.stickerId)
  )
}

// The like itself, or the image Meta sends with it (the same link, no id of its own)
function isPartOfLike(attachment: ParsedAttachment, like: ParsedAttachment): boolean {
  return attachment === like || (attachment.url !== undefined && attachment.url === like.url)
}

// A place the customer shared: its coordinates, and the name Meta gives it. The shared pin of the app has
// no link to a file, so it is not read as media. A pin with no usable coordinates is a shared thing like
// any other, kept as the marker.
function placeOf(attachments: ParsedAttachment[]): {
  name: string | null
  metadata: Record<string, unknown>
} | null {
  const found = attachments.find(
    attachment =>
      attachment.type === MetaMessaging.ATTACHMENT_LOCATION && attachment.coordinates !== undefined
  )
  if (!found?.coordinates) return null
  const name = placeTextOf(found.title)
  return {
    name,
    metadata: {
      latitude: found.coordinates.lat,
      longitude: found.coordinates.long,
      ...(name === null ? {} : { name })
    }
  }
}

// What a message says, in the shape the core stores. A message with neither text nor a file we can
// fetch is kept as a text with no content and the provider's type in the metadata, so the customer's
// message is never lost and the interface decides how to show it.
// What the team needs to map a type this plugin cannot read, without a value of the customer: the names
// of the fields (the payload to two levels, `coordinates.lat`), never what they hold. Bounded, and a name that is not
// plain is left out, because it is the sender's.
const SHAPE_NAME = new RegExp(`^[A-Za-z0-9_]{1,${UnsupportedShapeLimits.NAME_MAX_LENGTH}}$`)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The top-level names come first and are capped alone, so nested ones never push them out
function plainNames(value: unknown, deep = false): string[] {
  if (!isRecord(value)) return []
  const top = Object.keys(value)
    .filter(name => SHAPE_NAME.test(name))
    .slice(0, UnsupportedShapeLimits.MAX_NAMES)
  if (!deep) return top
  const nested = top.flatMap(name =>
    Object.keys(isRecord(value[name]) ? value[name] : {})
      .filter(inner => SHAPE_NAME.test(inner))
      .slice(0, UnsupportedShapeLimits.MAX_NESTED_NAMES)
      .map(inner => `${name}.${inner}`)
  )
  return [...top, ...nested].slice(0, UnsupportedShapeLimits.MAX_NAMES)
}

export function shapeOf(message: MetaMessage, raw: unknown[]): Record<string, unknown> {
  return {
    messageFields: plainNames(message),
    attachments: raw.slice(0, UnsupportedShapeLimits.MAX_ATTACHMENTS).map(item => {
      const record = isRecord(item) ? item : {}
      const type = record.type
      return {
        type: typeof type === 'string' && SHAPE_NAME.test(type) ? type : UNSUPPORTED_TYPE,
        fields: plainNames(record),
        payloadFields: plainNames(record.payload, true)
      }
    })
  }
}

// The type name of a message that answers a story
const STORY_REPLY = 'story_reply'

function toReceivedMessage(
  message: MetaMessage,
  timestamp: string,
  origin: ChannelOrigin | undefined
): ReceivedMessage {
  const base = {
    externalId: message.mid,
    replyToExternalId: replyTarget(message.reply_to?.mid),
    timestamp,
    ...(origin ? { origin } : {})
  }
  const attachments = parseAttachments(message.attachments ?? [])
  const rawText = hasText(message.text) ? message.text : null
  const unsupported = message.is_unsupported === true
  // The like button: a sticker with a known id (and the image of the same link). It is a thumbs up,
  // so it is stored as that text and nothing is fetched.
  const like = unsupported ? undefined : likeOf(attachments)
  if (like && rawText === null && attachments.every(attachment => isPartOfLike(attachment, like))) {
    return { ...base, type: MessageType.TEXT, content: MetaMessaging.LIKE_TEXT }
  }
  const files = unsupported ? null : mediaOf(attachments)
  // The placeholder beside a photo is not the customer's text; kept when there is no file to explain it
  const text =
    files && rawText !== null && MetaMessaging.PLACEHOLDER_TEXTS.includes(rawText.trim())
      ? null
      : rawText
  // A place beside a file stays a shared thing with the file, so the file is kept; beside words it keeps them
  const place = unsupported || files ? null : placeOf(attachments)
  if (place) {
    return {
      ...base,
      type: MessageType.LOCATION,
      content: text ?? place.name,
      metadata: place.metadata
    }
  }
  const shared = unsupported ? null : sharedOf(attachments)
  // The name of a type is the sender's, and it goes into the metadata and the content: only a plain one
  const providerType = shared && PROVIDER_TYPE.test(shared.type) ? shared.type : UNSUPPORTED_TYPE
  // A shared post or reel keeps its link beside the text or the file, so the team can open it; so does
  // the story an Instagram customer replied to (IG-07), when nothing else was shared
  const storyUrl = message.reply_to?.story?.url
  const link = shared?.url
    ? {
        metadata: {
          [MessageMetadataKeys.ATTACHMENT_TYPE]: providerType,
          attachmentUrl: shared.url
        }
      }
    : storyUrl && !files
      ? {
          metadata: { [MessageMetadataKeys.ATTACHMENT_TYPE]: STORY_REPLY, attachmentUrl: storyUrl }
        }
      : {}
  if (files) {
    // MSG-STK: a sticker is an image to the core; the mark lets the thread draw it without a bubble
    const sticker = isStickerOnly(attachments, files.media)
    const metadata = {
      ...('metadata' in link ? link.metadata : {}),
      ...(sticker ? { [MessageMetadataKeys.STICKER]: true } : {})
    }
    return {
      ...base,
      type: files.type,
      content: text,
      media: files.media,
      ...(Object.keys(metadata).length === 0 ? {} : { metadata })
    }
  }
  if (text !== null) return { ...base, type: MessageType.TEXT, content: text, ...link }
  return {
    ...base,
    type: MessageType.TEXT,
    content: `[${providerType}]`,
    metadata: {
      [MessageMetadataKeys.ATTACHMENT_TYPE]: providerType,
      [MessageMetadataKeys.UNSUPPORTED_TYPE]: providerType,
      [MessageMetadataKeys.UNSUPPORTED_SHAPE]: shapeOf(message, message.attachments ?? []),
      ...(shared?.url ? { attachmentUrl: shared.url } : {})
    }
  }
}

// A reaction the customer made. One whose emoji is not a whole emoji is not a reaction at all, and
// must not undo an earlier one; taking it back needs no emoji.
function reactionEvent(
  connectionId: string,
  item: MetaMessagingItem,
  timestamp: string
): ChannelEvent | null {
  const reaction = item.reaction
  const targetExternalId = replyTarget(reaction?.mid)
  if (!reaction || !targetExternalId) return null
  let emoji: string | null
  if (reaction.action === MetaMessaging.REACTION_UNREACT) {
    emoji = null
  } else if (
    reaction.action === MetaMessaging.REACTION_REACT &&
    reaction.emoji !== undefined &&
    isWholeEmoji(reaction.emoji, InboundLimits.EMOJI_MAX_LENGTH)
  ) {
    emoji = reaction.emoji
  } else {
    return null
  }
  return {
    type: ChannelEventTypes.MESSAGE_REACTION,
    connectionId,
    channelIdentity: item.sender.id,
    reaction: { targetExternalId, emoji },
    timestamp
  }
}

// A message taken back. The customer's is a deletion by the customer; the page's own, which the provider
// echoes, is one by the owner in the provider's app. Anything that is neither is not ours.
function deletionEvent(
  connectionId: string,
  item: MetaMessagingItem,
  mid: string,
  timestamp: string
): ChannelEvent | null {
  const byPage = item.sender.id === connectionId
  if (!byPage && item.recipient.id !== connectionId) return null
  if (item.sender.id === item.recipient.id) return null
  return {
    type: ChannelEventTypes.MESSAGE_DELETED,
    connectionId,
    channelIdentity: byPage ? item.recipient.id : item.sender.id,
    deletion: { targetExternalId: mid, ...(byPage ? { from: ReactionActors.EXTERNAL } : {}) },
    timestamp
  }
}

// The customer edited a message: the whole new text, and the number of the edit to tell one from the next
function editEvent(
  connectionId: string,
  item: MetaMessagingItem,
  edit: MetaMessageEdit,
  timestamp: string
): ChannelEvent | null {
  if (item.sender.id === item.recipient.id || !hasText(edit.text)) return null
  return {
    type: ChannelEventTypes.MESSAGE_EDITED,
    connectionId,
    channelIdentity: item.sender.id,
    edit: {
      targetExternalId: edit.mid,
      content: edit.text,
      ...(edit.num_edit === undefined ? {} : { eventId: `${edit.mid}:${edit.num_edit}` })
    },
    timestamp
  }
}

// The ad can come beside the message or inside it; an empty object says nothing, so the next one is tried
function firstReferral(
  ...candidates: (Record<string, unknown> | undefined)[]
): Record<string, unknown> | undefined {
  return candidates.find(candidate => candidate !== undefined && Object.keys(candidate).length > 0)
}

function itemEvent(connectionId: string, item: MetaMessagingItem): ChannelEvent | null {
  const timestamp = new Date(item.timestamp).toISOString()
  const message = item.message
  if (message) {
    if (message.is_deleted) return deletionEvent(connectionId, item, message.mid, timestamp)
    // The page wrote to the customer (the customer is the recipient), or the customer wrote to the
    // page: anything else is not ours, and is dropped before its attachments are read
    const isEcho = message.is_echo === true
    if (isEcho ? item.sender.id !== connectionId : item.recipient.id !== connectionId) return null
    // The customer is the other side: the account does not talk to itself
    if (item.sender.id === item.recipient.id) return null
    const received = toReceivedMessage(
      message,
      timestamp,
      originOf(firstReferral(item.referral, message.referral))
    )
    return isEcho
      ? {
          type: ChannelEventTypes.MESSAGE_ECHO,
          connectionId,
          channelIdentity: item.recipient.id,
          message: received,
          timestamp
        }
      : {
          type: ChannelEventTypes.MESSAGE_RECEIVED,
          connectionId,
          channelIdentity: item.sender.id,
          message: received,
          timestamp
        }
  }
  if (item.message_edit && item.recipient.id === connectionId) {
    return editEvent(connectionId, item, item.message_edit, timestamp)
  }
  // Only the customer's reactions: those of the account itself come back as the echo of our own sends,
  // and the core already holds them
  if (item.reaction && item.recipient.id === connectionId) {
    return reactionEvent(connectionId, item, timestamp)
  }
  return null
}

// A webhook of Meta is untrusted: what does not fit is skipped, never thrown. `entry.id` is the Page
// or the Instagram account that received the event, and it resolves the store.
export function messagingToEvents(payload: unknown, webhookObject: string): ChannelEvent[] {
  const envelope = metaWebhookSchema.safeParse(payload)
  if (!envelope.success || envelope.data.object !== webhookObject) return []
  const events: ChannelEvent[] = []
  for (const rawEntry of envelope.data.entry) {
    const entry = parseMessagingEntry(rawEntry)
    if (!entry) continue
    for (const rawItem of entry.messaging) {
      const item = parseMessagingItem(rawItem)
      const event = item ? itemEvent(entry.id, item) : null
      if (event) events.push(event)
    }
  }
  return events
}
