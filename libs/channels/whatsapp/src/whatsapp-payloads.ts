import {
  InboundLimits,
  WHATSAPP_USER_ID_PATTERN,
  WhatsAppApi,
  WhatsAppInteractiveTypes,
  WhatsAppLimits,
  WhatsAppMediaTypes,
  WhatsAppMessageTypes,
  WhatsAppTemplateComponents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  PluginError,
  type PluginErrorCode,
  type SendButtonsParams,
  type SendLocationParams,
  type SendMediaParams,
  type SendMessageParams,
  type SendReactionParams,
  type SendTemplateParams
} from '@platform/plugins/sdk'

// The bodies of POST /{phone-number-id}/messages. They are pure: what cannot be sent is refused here,
// before any call, and it will not become sendable by trying again.

// E.164 allows 15 digits at most
const PHONE_DIGITS = /^\d{5,15}$/
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/
// Meta refuses a parameter that is empty, has a line break or a tab, or more than four spaces in a row
const BAD_VARIABLE = /^\s*$|[\n\t]| {5,}/
const LANGUAGE_CODE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/

// Meta counts characters, not UTF-16 units: an emoji is one
const size = (text: string): number => Array.from(text).length

function refuse(code: PluginErrorCode = ErrorCodes.CHANNEL_MESSAGE_FAILED): never {
  throw new PluginError(code, { retryable: false })
}

// A customer is addressed by the number (E.164 without the plus) or, when the number does not arrive,
// by the user id Meta gave: `recipient` instead of `to`
type Addressee = { to: string } | { recipient: string }

interface Envelope {
  messaging_product: typeof WhatsAppApi.MESSAGING_PRODUCT
  recipient_type: typeof WhatsAppApi.RECIPIENT_TYPE
  context?: { message_id: string }
}

function addressee(identity: string): Addressee {
  if (WHATSAPP_USER_ID_PATTERN.test(identity)) return { recipient: identity }
  if (!PHONE_DIGITS.test(identity)) refuse()
  return { to: identity }
}

function envelope(identity: string, replyToExternalId?: string): Envelope & Addressee {
  return {
    messaging_product: WhatsAppApi.MESSAGING_PRODUCT,
    recipient_type: WhatsAppApi.RECIPIENT_TYPE,
    ...addressee(identity),
    ...(replyToExternalId ? { context: { message_id: replyToExternalId } } : {})
  }
}

export function textPayload(params: SendMessageParams): object {
  if (params.content.trim() === '' || size(params.content) > WhatsAppLimits.TEXT_MAX_LENGTH)
    refuse()
  return {
    ...envelope(params.channelIdentity, params.replyToExternalId),
    type: WhatsAppMessageTypes.TEXT,
    // A link in a reply is shown as text, with no preview that fetches it
    text: { body: params.content, preview_url: false }
  }
}

// The kind of message that carries a file of this content type: the types Meta takes as image, video
// or audio, and everything else as a document (a webp or a wav sent as an image is refused by Meta)
const MEDIA_KINDS = [
  WhatsAppMessageTypes.IMAGE,
  WhatsAppMessageTypes.VIDEO,
  WhatsAppMessageTypes.AUDIO
] as const

function mediaKind(contentType: string): 'image' | 'video' | 'audio' | 'document' {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  for (const kind of MEDIA_KINDS) {
    if (WhatsAppMediaTypes[kind].includes(type)) return kind
  }
  return 'document'
}

export function mediaPayload(params: SendMediaParams): object {
  const kind = mediaKind(params.contentType)
  // A blank caption is no caption, for every kind
  const caption = params.caption?.trim() ? params.caption : undefined
  let url: URL
  try {
    url = new URL(params.mediaUrl)
  } catch {
    return refuse()
  }
  // Meta fetches the file itself, and only over https
  // And a url with a user or a password would hand them to Meta
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') refuse()
  if (size(caption ?? '') > WhatsAppLimits.CAPTION_MAX_LENGTH) refuse()
  // An audio has no caption: dropping the text would lose part of the reply, so it is refused
  if (kind === 'audio' && caption) refuse(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
  if (size(params.filename ?? '') > WhatsAppLimits.FILENAME_MAX_LENGTH) refuse()

  return {
    ...envelope(params.channelIdentity, params.replyToExternalId),
    type: kind,
    [kind]: {
      link: url.toString(),
      ...(kind === 'audio' || !caption ? {} : { caption }),
      ...(kind === 'document' && params.filename ? { filename: params.filename } : {})
    }
  }
}

export function templatePayload(params: SendTemplateParams): object {
  if (
    !TEMPLATE_NAME.test(params.templateName) ||
    !LANGUAGE_CODE.test(params.language) ||
    params.variables.some(variable => BAD_VARIABLE.test(variable))
  ) {
    refuse()
  }
  return {
    ...envelope(params.channelIdentity),
    type: WhatsAppMessageTypes.TEMPLATE,
    template: {
      name: params.templateName,
      language: { code: params.language },
      ...(params.variables.length === 0
        ? {}
        : {
            components: [
              {
                type: WhatsAppTemplateComponents.BODY_PARAMETERS,
                parameters: params.variables.map(text => ({
                  type: WhatsAppTemplateComponents.TEXT_PARAMETER,
                  text
                }))
              }
            ]
          })
    }
  }
}

export function buttonsPayload(params: SendButtonsParams): object {
  const { buttons, content } = params
  if (
    buttons.length === 0 ||
    buttons.length > WhatsAppLimits.BUTTONS_MAX ||
    content.trim() === '' ||
    size(content) > WhatsAppLimits.BUTTONS_BODY_MAX_LENGTH ||
    new Set(buttons.map(button => button.title)).size !== buttons.length ||
    // The id is what comes back when the customer taps: two with one id cannot be told apart
    new Set(buttons.map(button => button.id)).size !== buttons.length ||
    buttons.some(
      button =>
        button.title.trim() === '' ||
        size(button.title) > WhatsAppLimits.BUTTON_TITLE_MAX_LENGTH ||
        button.id.length === 0 ||
        size(button.id) > WhatsAppLimits.BUTTON_ID_MAX_LENGTH
    )
  ) {
    refuse()
  }
  return {
    ...envelope(params.channelIdentity),
    type: WhatsAppMessageTypes.INTERACTIVE,
    interactive: {
      type: WhatsAppInteractiveTypes.BUTTON,
      body: { text: content },
      action: {
        buttons: buttons.map(button => ({
          type: WhatsAppInteractiveTypes.REPLY,
          reply: { id: button.id, title: button.title }
        }))
      }
    }
  }
}

export function locationPayload(params: SendLocationParams): object {
  const { latitude, longitude, name } = params
  if (
    !(latitude >= -90 && latitude <= 90) ||
    !(longitude >= -180 && longitude <= 180) ||
    size(name ?? '') > WhatsAppLimits.LOCATION_NAME_MAX_LENGTH
  ) {
    refuse()
  }
  return {
    ...envelope(params.channelIdentity),
    type: WhatsAppMessageTypes.LOCATION,
    location: { latitude, longitude, ...(name ? { name } : {}) }
  }
}

export function readReceiptPayload(externalId: string): object {
  if (externalId.trim() === '' || externalId.length > InboundLimits.ID_MAX_LENGTH) refuse()
  return {
    messaging_product: WhatsAppApi.MESSAGING_PRODUCT,
    status: WhatsAppApi.READ_STATUS,
    message_id: externalId
  }
}

// An empty emoji takes the reaction back
export function reactionPayload(params: SendReactionParams): object {
  const { targetExternalId, emoji } = params
  if (targetExternalId.trim() === '' || targetExternalId.length > InboundLimits.ID_MAX_LENGTH) {
    refuse()
  }
  // The core checks the emoji too; a plugin does not trust its caller, as the other builders do not
  if (emoji !== null && (emoji.trim() === '' || emoji.length > InboundLimits.EMOJI_MAX_LENGTH)) {
    refuse()
  }
  return {
    ...envelope(params.channelIdentity),
    type: WhatsAppMessageTypes.REACTION,
    reaction: { message_id: targetExternalId, emoji: emoji ?? '' }
  }
}
