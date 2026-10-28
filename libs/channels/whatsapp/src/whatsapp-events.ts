import {
  InboundLimits,
  MessageType,
  WHATSAPP_USER_ID_PATTERN,
  WhatsAppInteractiveTypes,
  WhatsAppMediaFallback,
  WhatsAppMessageTypes,
  WhatsAppStatuses,
  WhatsAppWebhook
} from '@platform/core/domain'
import { type ChannelEvent, ChannelEventTypes } from '@platform/plugins/sdk'

import {
  parseChangeValue,
  parseEntryChanges,
  type WhatsAppChangeValue,
  type WhatsAppMessage,
  whatsAppContactSchema,
  whatsAppMessageSchema,
  type WhatsAppStatus,
  whatsAppStatusSchema,
  whatsAppWebhookSchema
} from './whatsapp-webhook.schema'

const MILLISECONDS = 1000
const CHANNEL_PROFILE_NAME_MAX_LENGTH = 200
const STATUS_ERROR_MESSAGE_MAX_LENGTH = 500

// The core refuses a whole event for one field that is too long, and Meta does not send it again, so
// an optional field that does not fit is cut or left out instead of costing the customer's message
// A file name is the customer's to choose. Whatever stores it later gets only the last segment, with no
// control characters, quotes or leading dots: no path, no header injection.
function safeFilename(name: string | undefined): string | null {
  if (!name) return null
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    // eslint-disable-next-line no-control-regex -- the point is to remove them
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return clean === '' ? null : cut(clean, InboundLimits.FILENAME_MAX_LENGTH)
}

// The phone, as the digits Meta writes, or the user id; anything else cannot be answered
const PHONE = /^\d{5,15}$/
const isIdentity = (id: string | undefined): id is string =>
  id !== undefined && (PHONE.test(id) || WHATSAPP_USER_ID_PATTERN.test(id))

// The name of a type goes into the visible content: letters, digits and underscore only
const PROVIDER_TYPE = /^[A-Za-z0-9_]{1,64}$/

const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join('')

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

// A reaction and a notice of the system are not something the customer wrote
const NOT_MESSAGES: ReadonlySet<string> = new Set([
  WhatsAppMessageTypes.REACTION,
  WhatsAppMessageTypes.SYSTEM
])

type ReceivedMessage = NonNullable<ChannelEvent['message']>

function isMediaKind(type: string): type is MediaKind {
  return MEDIA_TYPES.has(type)
}

// What a message says, in the shape the core stores. A type this plugin does not know is kept as a
// text with no content and its WhatsApp type in the metadata, so the customer's message is never
// lost and the interface decides how to show it.
// The core refuses a text with nothing but blanks, so a blank one is marked like an unknown type
const hasText = (text: string | undefined): boolean => text !== undefined && text.trim() !== ''

const replyTarget = (id: string | undefined): string | undefined =>
  id && id.length <= InboundLimits.ID_MAX_LENGTH ? id : undefined

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
        media: {
          ref: media.id,
          contentType:
            media.mime_type && media.mime_type.length <= InboundLimits.CONTENT_TYPE_MAX_LENGTH
              ? media.mime_type
              : WhatsAppMediaFallback.CONTENT_TYPE,
          filename: safeFilename(media.filename)
        }
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
    const received = toReceivedMessage(parsed.data)
    if (!received) continue
    // While the phone still arrives, the user id beside it is the only way to join the customer's two
    // identities later, once the phone stops
    const message =
      parsed.data.from && parsed.data.from_user_id
        ? {
            ...received,
            metadata: { ...received.metadata, whatsappUserId: parsed.data.from_user_id }
          }
        : received
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
      if (change.field !== WhatsAppWebhook.FIELD_MESSAGES) continue
      const value = parseChangeValue(change.value)
      if (value) events.push(...messageEvents(value), ...statusEvents(value))
    }
  }
  return events
}
