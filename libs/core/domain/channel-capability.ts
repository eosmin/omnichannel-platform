import type { MessageType } from './status-enums'

// What a channel plugin can do, by the name the channel directory sends. It lives with the domain
// constants so that the browser can ask for a capability by name; the plugin SDK re-exports it.
export const ChannelCapability = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  LOCATION: 'location',
  CONTACTS: 'contacts',
  BUTTONS: 'buttons',
  LIST_PICKER: 'list_picker',
  TEMPLATES: 'templates',
  TYPING_INDICATOR: 'typing_indicator',
  READ_RECEIPTS: 'read_receipts',
  DELIVERY_RECEIPTS: 'delivery_receipts',
  REACTIONS: 'reactions',
  DELETE_MESSAGE: 'delete_message',
  EDIT_MESSAGE: 'edit_message',
  REPLY_TO: 'reply_to',
  MESSAGING_WINDOW: 'messaging_window',
  CUSTOMER_TYPING: 'customer_typing',
  CUSTOMER_PROFILE: 'customer_profile',
  // The channel itself carries a different text under each file of a message (WhatsApp: the caption of each
  // file). A channel that sends the text of a file as a message of its own does not declare it, and the
  // composer offers it only the one text of the message.
  CAPTION_PER_FILE: 'caption_per_file'
} as const

export type ChannelCapabilityType = (typeof ChannelCapability)[keyof typeof ChannelCapability]

// How the handle of a customer on a channel is read (TDD_10 §6.7.2). A phone is compared as digits, so the same
// person is the same row however the channel spelled it; an opaque handle (a page-scoped id, a visitor id, a
// username) is kept as the channel sent it. A plugin says which one it is; the core never asks for its name.
export const ChannelIdentityKinds = {
  PHONE: 'phone',
  OPAQUE: 'opaque'
} as const
export type ChannelIdentityKind = (typeof ChannelIdentityKinds)[keyof typeof ChannelIdentityKinds]

// Where the core asks how the handle of a customer on a channel is read. The plugins module provides it from the
// registry; a channel the registry does not know is opaque (kept as it came).
export interface ChannelIdentityKindSource {
  kindOf(channelType: string): ChannelIdentityKind
}
export const CHANNEL_IDENTITY_KINDS = Symbol('CHANNEL_IDENTITY_KINDS')

// What a channel holds of the text of a message, declared by its plugin. `POST /messages` caps at
// MessageLimits.CONTENT_MAX_LENGTH, so a plugin cannot declare more than the platform stores.
export interface ChannelLimits {
  // The most characters one message takes
  textMaxLength: number
  // Only for a channel that carries a text under a file (its caption) with a limit of its own or for no
  // kind at all. Absent: the text under a file is held to `textMaxLength`.
  caption?: {
    maxLength: number
    // The kinds of file that carry no caption at all
    withoutCaption: readonly MessageType[]
  }
}
