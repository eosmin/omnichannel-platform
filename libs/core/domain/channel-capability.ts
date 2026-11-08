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
