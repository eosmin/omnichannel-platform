import {
  httpUrl,
  InboundLimits,
  isWholeEmoji,
  MessageType,
  MetaGraph,
  MetaMessaging,
  OriginKinds,
  OriginMediaTypes
} from '@platform/core/domain'
import { type ChannelEvent, ChannelEventTypes, type ChannelOrigin } from '@platform/plugins/sdk'

import { cut, hasText, replyTarget } from './inbound-text'
import {
  metaAttachmentSchema,
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
  const isAd = referral.source === MetaMessaging.REFERRAL_SOURCE_ADS || referral.ad_id !== undefined
  const media = originMedia(context?.photo_url, context?.video_url)
  // A link in `source` is the m.me or ig.me link that was tapped
  const sourceUrl = URL_SCHEMA.safeParse(referral.source)
  return {
    kind: isAd ? OriginKinds.AD : OriginKinds.OTHER,
    ...(referral.ad_id ? { sourceId: referral.ad_id } : {}),
    ...(sourceUrl.success ? { sourceUrl: sourceUrl.data } : {}),
    ...(hasText(context?.ad_title)
      ? { title: cut(context?.ad_title ?? '', InboundLimits.ORIGIN_TITLE_MAX_LENGTH) }
      : {}),
    ...(media ? { media } : {}),
    ...(Buffer.byteLength(JSON.stringify(raw)) <= InboundLimits.METADATA_MAX_BYTES
      ? { referral: raw }
      : {})
  }
}

// The files of a message, with the url Meta put in the webhook as the reference to fetch them
function mediaOf(attachments: unknown[]): {
  type: MessageType
  media: NonNullable<ReceivedMessage['media']>
} | null {
  const media: NonNullable<ReceivedMessage['media']>[number][] = []
  let type: MessageType | undefined
  for (const item of attachments) {
    const attachment = metaAttachmentSchema.safeParse(item)
    const kind = attachment.success ? MEDIA_ATTACHMENTS.get(attachment.data.type) : undefined
    const url = attachment.success ? attachment.data.payload?.url : undefined
    if (!kind || !url) continue
    type ??= kind
    // Meta does not say the type of the file in the webhook: the fetch reads it from the file
    media.push({ ref: url, contentType: MetaGraph.FALLBACK_CONTENT_TYPE, filename: null })
    if (media.length === InboundLimits.MAX_MEDIA_PER_MESSAGE) break
  }
  return type ? { type, media } : null
}

// The attachment that is not a file (a shared post, a reel, a story mention): its type and, when
// there is one, its link, so the team can open what the customer shared
function sharedOf(attachments: unknown[]): { type: string; url?: string } | null {
  for (const item of attachments) {
    const attachment = metaAttachmentSchema.safeParse(item)
    if (attachment.success) {
      return { type: attachment.data.type, url: attachment.data.payload?.url }
    }
  }
  return null
}

// What a message says, in the shape the core stores. A message with neither text nor a file we can
// fetch is kept as a text with no content and the provider's type in the metadata, so the customer's
// message is never lost and the interface decides how to show it.
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
  const text = hasText(message.text) ? (message.text ?? null) : null
  const attachments = message.attachments ?? []
  const files = message.is_unsupported ? null : mediaOf(attachments)
  if (files) return { ...base, type: files.type, content: text, media: files.media }
  if (text !== null) return { ...base, type: MessageType.TEXT, content: text }

  const shared = message.is_unsupported ? null : sharedOf(attachments)
  const providerType = shared && PROVIDER_TYPE.test(shared.type) ? shared.type : UNSUPPORTED_TYPE
  return {
    ...base,
    type: MessageType.TEXT,
    content: `[${providerType}]`,
    metadata: {
      attachmentType: providerType,
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

function itemEvent(connectionId: string, item: MetaMessagingItem): ChannelEvent | null {
  const timestamp = new Date(item.timestamp).toISOString()
  const message = item.message
  if (message) {
    // The customer took it back: there is nothing new to store
    if (message.is_deleted) return null
    const received = toReceivedMessage(
      message,
      timestamp,
      originOf(item.referral ?? message.referral)
    )
    if (message.is_echo) {
      // The page wrote to the customer: the customer is the recipient
      if (item.sender.id !== connectionId) return null
      return {
        type: ChannelEventTypes.MESSAGE_ECHO,
        connectionId,
        channelIdentity: item.recipient.id,
        message: received,
        timestamp
      }
    }
    // Only what reaches this account is a customer's message
    if (item.recipient.id !== connectionId) return null
    return {
      type: ChannelEventTypes.MESSAGE_RECEIVED,
      connectionId,
      channelIdentity: item.sender.id,
      message: received,
      timestamp
    }
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
