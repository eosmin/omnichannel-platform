// The WhatsApp Cloud API as the WhatsApp plugin speaks it. It lives in the WhatsApp library: core, api, worker and
// web do not know it. The pieces Meta's channels share (origin, signature, error codes) are in the Meta library.
export const WhatsAppApi = {
  MESSAGING_PRODUCT: 'whatsapp',
  RECIPIENT_TYPE: 'individual',
  // Edges of a phone number and of a business account
  EDGE_MESSAGES: 'messages',
  EDGE_MEDIA: 'media', // POST /{phone-number-id}/media uploads a file and answers its id
  EDGE_TEMPLATES: 'message_templates',
  EDGE_SUBSCRIBED_APPS: 'subscribed_apps',
  EDGE_PHONE_NUMBERS: 'phone_numbers',
  PHONE_FIELDS: 'display_phone_number,verified_name',
  TEMPLATE_FIELDS: 'name,language,status,components',
  READ_STATUS: 'read',
  // `typing_indicator.type` of a read receipt: Meta takes only this one
  TYPING_INDICATOR_TYPE: 'text'
} as const

// `object` of a webhook, and the one field the plugin subscribes to
export const WhatsAppWebhook = {
  OBJECT: 'whatsapp_business_account',
  FIELD_MESSAGES: 'messages',
  // Only for a number in Coexistence: what the business writes in the WhatsApp Business app
  FIELD_MESSAGE_ECHOES: 'smb_message_echoes'
} as const

// `referral.source_type`: what the customer tapped before writing
export const WhatsAppReferralSourceTypes = {
  AD: 'ad',
  POST: 'post'
} as const

// The `type` of an inbound message and of an outbound one
export const WhatsAppMessageTypes = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  STICKER: 'sticker',
  LOCATION: 'location',
  CONTACTS: 'contacts',
  INTERACTIVE: 'interactive',
  BUTTON: 'button',
  REACTION: 'reaction',
  // Not a message of the customer: a number that changed, a group that was renamed
  SYSTEM: 'system',
  // Only in an echo of the business app: it deleted or edited a message it had sent
  REVOKE: 'revoke',
  EDIT: 'edit',
  // Outbound only
  TEMPLATE: 'template'
} as const

export const WhatsAppInteractiveTypes = {
  BUTTON_REPLY: 'button_reply',
  LIST_REPLY: 'list_reply',
  // Outbound: a message with reply buttons
  BUTTON: 'button',
  REPLY: 'reply'
} as const

export const WhatsAppStatuses = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
  DELETED: 'deleted'
} as const

export const WhatsAppTemplateStatuses = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  IN_APPEAL: 'IN_APPEAL'
} as const

export const WhatsAppTemplateComponents = {
  BODY: 'BODY',
  FOOTER: 'FOOTER',
  HEADER: 'HEADER',
  BUTTONS: 'BUTTONS',
  TEXT_FORMAT: 'TEXT',
  // The buttons that need nothing at send time; COPY_CODE, OTP, FLOW, MPM and the rest want a parameter
  FILLABLE_BUTTONS: ['QUICK_REPLY', 'PHONE_NUMBER', 'URL'],
  // Outbound component of a template send
  BODY_PARAMETERS: 'body',
  TEXT_PARAMETER: 'text'
} as const

// What the file of a type is sent as when the platform only knows its content type
export const WhatsAppMediaFallback = {
  CONTENT_TYPE: 'application/octet-stream'
} as const

// The content types the Cloud API takes as each kind of media. The plugin refuses any other before
// uploading it: Meta would (error 131053)
// (https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media)
export const WhatsAppMediaTypes: Readonly<
  Record<'image' | 'video' | 'audio' | 'document', readonly string[]>
> = {
  image: ['image/jpeg', 'image/png'],
  video: ['video/mp4', 'video/3gpp'],
  audio: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
  // Meta takes these as a document and refuses any other type (error 131053)
  document: [
    'text/plain',
    'application/pdf',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
}

const MEGABYTE = 1024 * 1024
// The most one upload may weigh, by kind, from the same page of Meta's documentation
export const WhatsAppMediaMaxBytes: Readonly<
  Record<'image' | 'video' | 'audio' | 'document', number>
> = {
  image: 5 * MEGABYTE,
  video: 16 * MEGABYTE,
  audio: 16 * MEGABYTE,
  document: 100 * MEGABYTE
}

// A business-scoped user id (BSUID), the id Meta gives every customer in place of the phone number:
// `US.13491208655302741918`, or `BR.ENT.9988776655` for a business that uses parent ids. Once a
// customer adopts a username the phone stops arriving, and this is all there is to write back to.
export const WHATSAPP_USER_ID_PATTERN = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,64}$/

export const WhatsAppLimits = {
  TEXT_MAX_LENGTH: 4096,
  // https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
  CAPTION_MAX_LENGTH: 1024,
  FILENAME_MAX_LENGTH: 240,
  BUTTONS_MAX: 3,
  BUTTON_TITLE_MAX_LENGTH: 20,
  BUTTON_ID_MAX_LENGTH: 256,
  BUTTONS_BODY_MAX_LENGTH: 1024,
  LOCATION_NAME_MAX_LENGTH: 1000,
  // A page of a listing (templates, phone numbers), and how many pages one reads before it stops
  PAGE_SIZE: 100,
  MAX_PAGES: 5
} as const
