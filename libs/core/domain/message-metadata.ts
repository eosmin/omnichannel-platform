// Keys a channel plugin writes into `Message.metadata` for the thread to read back. The column is
// Json, so every reader parses it at the boundary; a key of a newer server is ignored.
export const MessageMetadataKeys = {
  // true on an image the customer sent as a sticker: the thread draws it without a bubble
  STICKER: 'sticker'
} as const
