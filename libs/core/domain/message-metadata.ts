// Keys a channel plugin writes into `Message.metadata` for the thread to read back. The column is
// Json, so every reader parses it at the boundary; a key of a newer server is ignored.
export const MessageMetadataKeys = {
  // true on an image the customer sent as a sticker: the thread draws it without a bubble
  STICKER: 'sticker',
  // The provider's name for what a shared link is (a post, a reel, a story mention)
  ATTACHMENT_TYPE: 'attachmentType',
  // Set only on a message whose whole text is the marker `[name]` that a channel stores for a type it
  // cannot read. It is what tells the marker from a customer who typed the same words.
  UNSUPPORTED_TYPE: 'unsupportedType',
  // Beside it: the names (never the values) of the fields that message carried, so the worker logs them
  // and the team can map the type. It never leaves in a view of the thread.
  UNSUPPORTED_SHAPE: 'unsupportedShape',
  // The contact cards of a CONTACTS message: a list of `{ name, phones, emails }`, bounded by `ContactCardLimits`
  CONTACTS: 'contacts',
  // Set on a message that answers a story of the business: `{ url? }`, the link of the story as the provider
  // gave it (it expires within about a day, and may not come). Channel agnostic: the thread draws a card
  // from it, whatever the channel that wrote it.
  STORY_REPLY: 'storyReply'
} as const

// What a contact card a customer shares may carry. Channel agnostic: each plugin cuts what its provider
// sends to these, and drops the rest of the card (addresses, birthdays, links) instead of keeping it.
export const ContactCardLimits = {
  MAX_CONTACTS: 10,
  MAX_PHONES: 5,
  MAX_EMAILS: 3,
  NAME_MAX_LENGTH: 200,
  PHONE_MAX_LENGTH: 32,
  EMAIL_MAX_LENGTH: 254,
  // The kind a provider gives a phone or an email ("HOME", "WORK", "CELL")
  KIND_MAX_LENGTH: 32
} as const

export interface ContactCard {
  name: string
  phones: { number: string; kind?: string }[]
  emails: { address: string; kind?: string }[]
}

// The bounds of `unsupportedShape`, shared by the plugin that writes it and the worker that logs it. The
// worst case (see its test) leaves room under `InboundLimits.METADATA_MAX_BYTES` for the link beside it:
// a shape that does not fit would cost the whole message.
export const UnsupportedShapeLimits = {
  MAX_ATTACHMENTS: 3,
  MAX_NAMES: 12,
  NAME_MAX_LENGTH: 32,
  // A name under another (`coordinates.lat`) at most this many per parent
  MAX_NESTED_NAMES: 4,
  // The names of the elements of a template that are read (up to three), and of what they hold one level down
  MAX_ELEMENT_NAMES: 16
} as const
