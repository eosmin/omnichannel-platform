export const ChannelCapability = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  LOCATION: 'location',
  BUTTONS: 'buttons',
  LIST_PICKER: 'list_picker',
  TEMPLATES: 'templates',
  TYPING_INDICATOR: 'typing_indicator',
  READ_RECEIPTS: 'read_receipts',
  DELIVERY_RECEIPTS: 'delivery_receipts',
  REACTIONS: 'reactions',
  REPLY_TO: 'reply_to',
  MESSAGING_WINDOW: 'messaging_window',
  CUSTOMER_TYPING: 'customer_typing'
} as const

export type ChannelCapabilityType = (typeof ChannelCapability)[keyof typeof ChannelCapability]
