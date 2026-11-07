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
  // The contact cards of a CONTACTS message: a list of `{ name, phones, emails }`, bounded by `ContactCardLimits`
  CONTACTS: 'contacts'
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
