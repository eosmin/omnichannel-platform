import { cut, hasText, replyTarget, safeFilename } from '@platform/channels/meta'
import {
  InboundLimits,
  isWholeEmoji,
  MessageType,
  OriginKinds,
  OriginMediaTypes,
  type ReactionActor,
  ReactionActors,
  WHATSAPP_USER_ID_PATTERN,
  WhatsAppInteractiveTypes,
  WhatsAppMediaFallback,
  WhatsAppMessageTypes,
  WhatsAppReferralSourceTypes,
  WhatsAppStatuses,
  WhatsAppWebhook
} from '@platform/core/domain'
import { type ChannelEvent, ChannelEventTypes, type ChannelOrigin } from '@platform/plugins/sdk'

import {
  parseChangeValue,
  parseEntryChanges,
  type WhatsAppChangeValue,
  type WhatsAppReferral,
  type WhatsAppMessage,
  whatsAppContactSchema,
  whatsAppEchoSchema,
  whatsAppMessageSchema,
  whatsAppReferralSchema,
  type WhatsAppStatus,
  whatsAppStatusSchema,
  whatsAppWebhookSchema
} from './whatsapp-webhook.schema'

const MILLISECONDS = 1000
const CHANNEL_PROFILE_NAME_MAX_LENGTH = 200
const STATUS_ERROR_MESSAGE_MAX_LENGTH = 500

// The phone, as the digits Meta writes, or the user id; anything else cannot be answered
const PHONE = /^\d{5,15}$/
const isIdentity = (id: string | undefined): id is string =>
  id !== undefined && (PHONE.test(id) || WHATSAPP_USER_ID_PATTERN.test(id))

// The name of a type goes into the visible content: letters, digits and underscore only
const PROVIDER_TYPE = /^[A-Za-z0-9_]{1,64}$/

const isoFromUnixSeconds = (seconds: string): string =>
  new Date(Number(seconds) * MILLISECONDS).toISOString()

type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

// A Map and not an object: the type is a string of the sender's choosing, and 'constructor' or
// '__proto__' must not find a key in Object.prototype
const MEDIA_TYPES: ReadonlyMap<string, MessageType> = new Map([
  [WhatsAppMessageTypes.IMAGE, MessageType.IMAGE],
  [WhatsAppMessageTypes.VIDEO, MessageType.VIDEO],
  [WhatsAppMessageTypes.AUDIO, MessageType.AUDIO],
  [WhatsAppMessageTypes.DOCUMENT, MessageType.DOCUMENT],
  // A sticker is an image the customer sent
  [WhatsAppMessageTypes.STICKER, MessageType.IMAGE]
])

// A notice of the system is not something the customer wrote. A reaction has an event of its own and
// never gets here.
const NOT_MESSAGES: ReadonlySet<string> = new Set([WhatsAppMessageTypes.SYSTEM])

// A deletion or an edit in the business app arrives as an echo of its own
const NOT_ECHOED: ReadonlySet<string> = new Set([
  WhatsAppMessageTypes.REVOKE,
  WhatsAppMessageTypes.EDIT
])

type ReceivedMessage = NonNullable<ChannelEvent['message']>

const REFERRAL_KINDS: ReadonlyMap<string, ChannelOrigin['kind']> = new Map([
  [WhatsAppReferralSourceTypes.AD, OriginKinds.AD],
  [WhatsAppReferralSourceTypes.POST, OriginKinds.POST]
])

// The creative of the ad: the link Meta sends, or the id of a media object that can be fetched
function originMedia(referral: WhatsAppReferral): ChannelOrigin['media'] {
  if (referral.image_url) return { type: OriginMediaTypes.IMAGE, url: referral.image_url }
  if (referral.video_url) return { type: OriginMediaTypes.VIDEO, url: referral.video_url }
  if (referral.image) return { type: OriginMediaTypes.IMAGE, ref: referral.image.id }
  if (referral.video) return { type: OriginMediaTypes.VIDEO, ref: referral.video.id }
  return undefined
}

// The ad or post the customer tapped. Nothing here can cost the message: a part that does not fit is
// left out, and the raw referral is kept only while it fits the limit of a metadata object.
function originOf(raw: Record<string, unknown> | undefined): ChannelOrigin | undefined {
  // An empty referral says nothing, and a thing that is not an object is not one
  if (raw === undefined || Object.keys(raw).length === 0) return undefined
  const parsed = whatsAppReferralSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const referral = parsed.data
  const media = originMedia(referral)
  const origin: ChannelOrigin = {
    kind: REFERRAL_KINDS.get(referral.source_type ?? '') ?? OriginKinds.OTHER,
    ...(referral.source_id ? { sourceId: referral.source_id } : {}),
    ...(referral.source_url ? { sourceUrl: referral.source_url } : {}),
    ...(hasText(referral.headline)
      ? { title: cut(referral.headline ?? '', InboundLimits.ORIGIN_TITLE_MAX_LENGTH) }
      : {}),
    ...(hasText(referral.body)
      ? { body: cut(referral.body ?? '', InboundLimits.ORIGIN_BODY_MAX_LENGTH) }
      : {}),
    ...(media ? { media } : {}),
    ...(referral.thumbnail_url ? { thumbnailUrl: referral.thumbnail_url } : {}),
    ...(referral.ctwa_clid ? { clickId: referral.ctwa_clid } : {}),
    ...(Buffer.byteLength(JSON.stringify(raw)) <= InboundLimits.METADATA_MAX_BYTES
      ? { referral: raw }
      : {})
  }
  return origin
}

function isMediaKind(type: string): type is MediaKind {
  return MEDIA_TYPES.has(type)
}

// What a message says, in the shape the core stores. A type this plugin does not know is kept as a
// text with no content and its WhatsApp type in the metadata, so the customer's message is never
// lost and the interface decides how to show it.
function toReceivedMessage(message: WhatsAppMessage): ReceivedMessage | null {
  const base = {
    externalId: message.id,
    replyToExternalId: replyTarget(message.context?.id),
    timestamp: isoFromUnixSeconds(message.timestamp)
  }

  if (NOT_MESSAGES.has(message.type)) return null

  if (isMediaKind(message.type)) {
    const media = message[message.type]
    if (media) {
      return {
        ...base,
        type: MEDIA_TYPES.get(message.type) ?? MessageType.DOCUMENT,
        content: hasText(media.caption) ? (media.caption ?? null) : null,
        media: [
          {
            ref: media.id,
            contentType:
              media.mime_type && media.mime_type.length <= InboundLimits.CONTENT_TYPE_MAX_LENGTH
                ? media.mime_type
                : WhatsAppMediaFallback.CONTENT_TYPE,
            filename: safeFilename(media.filename)
          }
        ]
      }
    }
  }

  if (message.type === WhatsAppMessageTypes.TEXT && hasText(message.text?.body)) {
    return { ...base, type: MessageType.TEXT, content: message.text?.body ?? null }
  }

  if (message.type === WhatsAppMessageTypes.LOCATION && message.location) {
    const { latitude, longitude, name, address } = message.location
    return {
      ...base,
      type: MessageType.LOCATION,
      content: [name, address].filter(Boolean).join(' - ') || null,
      metadata: { latitude, longitude }
    }
  }

  if (message.type === WhatsAppMessageTypes.INTERACTIVE && message.interactive) {
    const reply =
      message.interactive.type === WhatsAppInteractiveTypes.LIST_REPLY
        ? message.interactive.list_reply
        : message.interactive.button_reply
    if (reply && hasText(reply.title)) {
      return {
        ...base,
        type: MessageType.TEXT,
        content: reply.title,
        metadata: { replyId: cut(reply.id, InboundLimits.ID_MAX_LENGTH) }
      }
    }
  }

  if (message.type === WhatsAppMessageTypes.BUTTON && hasText(message.button?.text)) {
    return {
      ...base,
      type: MessageType.TEXT,
      content: message.button?.text ?? null,
      metadata: message.button?.payload
        ? { replyId: cut(message.button.payload, InboundLimits.ID_MAX_LENGTH) }
        : undefined
    }
  }

  // The core refuses a text with no text. The marker is the provider's name for the type, not a
  // sentence: the interface can draw it as it likes from `metadata.whatsappType`.
  const providerType = PROVIDER_TYPE.test(message.type) ? message.type : 'unknown'
  return {
    ...base,
    type: MessageType.TEXT,
    content: `[${providerType}]`,
    metadata: { whatsappType: providerType }
  }
}

const STATUS_EVENTS: ReadonlyMap<string, ChannelEvent['type']> = new Map([
  [WhatsAppStatuses.SENT, ChannelEventTypes.MESSAGE_SENT],
  [WhatsAppStatuses.DELIVERED, ChannelEventTypes.MESSAGE_DELIVERED],
  [WhatsAppStatuses.READ, ChannelEventTypes.MESSAGE_READ],
  [WhatsAppStatuses.FAILED, ChannelEventTypes.MESSAGE_FAILED]
])

const displayName = (name: string | undefined): string | undefined =>
  name ? cut(name, CHANNEL_PROFILE_NAME_MAX_LENGTH) : undefined

// No emoji, or an empty one, takes the reaction back. One that is only blanks, or too long to be an
// emoji, is not a reaction at all, and must not undo an earlier one.
function reactionEvent(
  connectionId: string,
  identity: string,
  message: WhatsAppMessage,
  from?: ReactionActor
): ChannelEvent | null {
  const reaction = message.reaction
  const targetExternalId = replyTarget(reaction?.message_id)
  if (!reaction || !targetExternalId) return null
  const emoji = reaction.emoji === undefined || reaction.emoji === '' ? null : reaction.emoji
  if (emoji !== null && !isWholeEmoji(emoji, InboundLimits.EMOJI_MAX_LENGTH)) return null
  return {
    type: ChannelEventTypes.MESSAGE_REACTION,
    connectionId,
    channelIdentity: identity,
    reaction: {
      targetExternalId,
      emoji,
      ...(from ? { from } : {}),
      ...(replyTarget(message.id) ? { eventId: message.id } : {})
    },
    timestamp: isoFromUnixSeconds(message.timestamp)
  }
}

function messageEvents(value: WhatsAppChangeValue): ChannelEvent[] {
  const connectionId = value.metadata.phone_number_id
  const names = new Map<string, string | undefined>()
  for (const item of value.contacts ?? []) {
    const contact = whatsAppContactSchema.safeParse(item)
    if (!contact.success) continue
    // Either id finds the name: the phone may be the one that is missing
    for (const id of [contact.data.wa_id, contact.data.user_id]) {
      if (id) names.set(id, contact.data.profile?.name)
    }
  }
  const events: ChannelEvent[] = []
  for (const item of value.messages ?? []) {
    const parsed = whatsAppMessageSchema.safeParse(item)
    if (!parsed.success) continue
    // The phone while it arrives; the user id once the customer has a username. With neither there is
    // nobody to answer.
    const identity = [parsed.data.from, parsed.data.from_user_id].find(isIdentity)
    if (!identity) continue
    if (parsed.data.type === WhatsAppMessageTypes.REACTION) {
      const reaction = reactionEvent(connectionId, identity, parsed.data)
      if (reaction) events.push(reaction)
      continue
    }
    const received = toReceivedMessage(parsed.data)
    if (!received) continue
    // While the phone still arrives, the user id beside it is the only way to join the customer's two
    // identities later, once the phone stops
    const origin = originOf(parsed.data.referral)
    const message = {
      ...(parsed.data.from && parsed.data.from_user_id
        ? {
            ...received,
            metadata: { ...received.metadata, whatsappUserId: parsed.data.from_user_id }
          }
        : received),
      ...(origin ? { origin } : {})
    }
    events.push({
      type: ChannelEventTypes.MESSAGE_RECEIVED,
      connectionId,
      channelIdentity: identity,
      channelProfile: { displayName: displayName(names.get(identity)) },
      message,
      timestamp: message.timestamp
    })
  }
  return events
}

// What the business wrote in its WhatsApp Business app, for a number in Coexistence. `to` is the
// customer. A message that was deleted or edited there is not a new message: the core has no edit.
function echoEvents(value: WhatsAppChangeValue): ChannelEvent[] {
  const connectionId = value.metadata.phone_number_id
  const events: ChannelEvent[] = []
  for (const item of value.message_echoes ?? []) {
    const parsed = whatsAppEchoSchema.safeParse(item)
    if (!parsed.success || NOT_ECHOED.has(parsed.data.type)) continue
    const identity = parsed.data.to?.replace(/^\+/, '')
    if (!isIdentity(identity)) continue
    if (parsed.data.type === WhatsAppMessageTypes.REACTION) {
      const reaction = reactionEvent(connectionId, identity, parsed.data, ReactionActors.EXTERNAL)
      if (reaction) events.push(reaction)
      continue
    }
    const message = toReceivedMessage(parsed.data)
    if (!message) continue
    events.push({
      type: ChannelEventTypes.MESSAGE_ECHO,
      connectionId,
      channelIdentity: identity,
      message,
      timestamp: message.timestamp
    })
  }
  return events
}

function statusEvent(connectionId: string, status: WhatsAppStatus): ChannelEvent | null {
  const type = STATUS_EVENTS.get(status.status)
  const identity = [status.recipient_id, status.recipient_user_id].find(isIdentity)
  if (!type || !identity) return null
  const error = status.errors?.[0]
  return {
    type,
    connectionId,
    channelIdentity: identity,
    status: {
      externalId: status.id,
      error: error && {
        code: String(error.code),
        message: cut(error.title ?? error.message ?? '', STATUS_ERROR_MESSAGE_MAX_LENGTH)
      }
    },
    timestamp: isoFromUnixSeconds(status.timestamp)
  }
}

function statusEvents(value: WhatsAppChangeValue): ChannelEvent[] {
  const events: ChannelEvent[] = []
  for (const item of value.statuses ?? []) {
    const parsed = whatsAppStatusSchema.safeParse(item)
    if (!parsed.success) continue
    const event = statusEvent(value.metadata.phone_number_id, parsed.data)
    if (event) events.push(event)
  }
  return events
}

// A webhook of Meta is untrusted: what does not fit is skipped, never thrown. The recipient
// (`phone_number_id`) is what resolves the store.
export function webhookToEvents(payload: unknown): ChannelEvent[] {
  const parsed = whatsAppWebhookSchema.safeParse(payload)
  if (!parsed.success) return []
  const events: ChannelEvent[] = []
  for (const entry of parsed.data.entry) {
    for (const change of parseEntryChanges(entry)) {
      if (
        change.field !== WhatsAppWebhook.FIELD_MESSAGES &&
        change.field !== WhatsAppWebhook.FIELD_MESSAGE_ECHOES
      ) {
        continue
      }
      const value = parseChangeValue(change.value)
      if (!value) continue
      if (change.field === WhatsAppWebhook.FIELD_MESSAGES) {
        events.push(...messageEvents(value), ...statusEvents(value))
      } else {
        events.push(...echoEvents(value))
      }
    }
  }
  return events
}
