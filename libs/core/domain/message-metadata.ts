// Keys a channel plugin writes into `Message.metadata` for the thread to read back. The column is
// Json, so every reader parses it at the boundary; a key of a newer server is ignored.
export const MessageMetadataKeys = {
  // true on an image the customer sent as a sticker: the thread draws it without a bubble
  STICKER: 'sticker',
  // The provider's name for what a shared link is (a post, a reel, a story mention)
  ATTACHMENT_TYPE: 'attachmentType',
  // Set only on a message whose whole text is the marker `[name]` that a channel stores for a type it
  // cannot read. It is what tells the marker from a customer who typed the same words.
  UNSUPPORTED_TYPE: 'unsupportedType'
} as const
