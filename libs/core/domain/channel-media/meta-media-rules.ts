import { MetaMessaging } from '../meta-constants'

import {
  type ChannelMediaCapabilities,
  type ChannelMediaKind,
  ChannelMediaKinds,
  frozenMedia,
  MetaMediaFilesPerMessage
} from './channel-media-rules'

const MEGABYTE = 1024 * 1024

// The kinds of attachment the Send API of Messenger and Instagram names
export type MetaMediaKind =
  | typeof MetaMessaging.ATTACHMENT_IMAGE
  | typeof MetaMessaging.ATTACHMENT_VIDEO
  | typeof MetaMessaging.ATTACHMENT_AUDIO
  | typeof MetaMessaging.ATTACHMENT_FILE

// The kind of attachment the Send API names for each kind of file of the platform
export const MetaAttachmentOfKind: Readonly<Record<ChannelMediaKind, MetaMediaKind>> = {
  [ChannelMediaKinds.IMAGE]: MetaMessaging.ATTACHMENT_IMAGE,
  [ChannelMediaKinds.VIDEO]: MetaMessaging.ATTACHMENT_VIDEO,
  [ChannelMediaKinds.AUDIO]: MetaMessaging.ATTACHMENT_AUDIO,
  [ChannelMediaKinds.DOCUMENT]: MetaMessaging.ATTACHMENT_FILE
}

// Meta, "Saving assets" (Messenger Platform): 8 MB for an image and 25 MB for any other file. The page lists
// no formats, so none is filtered here; Meta answers 100/2018047 for a type that does not match the file.
//
// Send API: one message may carry several attachments, but only images (Messenger up to 30, Instagram up to 10;
// Meta, read 2026-11-09). The platform lets an agent attach `MetaMediaFilesPerMessage` files to a message, so an album
// never holds more than that. Anything else is a message of its own.
export const MessengerMedia: ChannelMediaCapabilities = frozenMedia({
  maxFilesPerMessage: MetaMediaFilesPerMessage,
  album: { kinds: [ChannelMediaKinds.IMAGE], maxFiles: MetaMediaFilesPerMessage },
  kinds: {
    [ChannelMediaKinds.IMAGE]: { types: null, maxBytes: 8 * MEGABYTE },
    [ChannelMediaKinds.VIDEO]: { types: null, maxBytes: 25 * MEGABYTE },
    [ChannelMediaKinds.AUDIO]: { types: null, maxBytes: 25 * MEGABYTE },
    [ChannelMediaKinds.DOCUMENT]: { types: null, maxBytes: 25 * MEGABYTE }
  }
})

// Meta, "Upload Media for Instagram Messaging" and "Send a message" (Instagram Messaging, read 2026-11-07):
// image png/jpeg/gif up to 8 MB; audio aac/m4a/wav/mp4 up to 25 MB; video mp4/ogg/avi/mov/webm up to 25 MB;
// file: pdf only, up to 25 MB.
export const InstagramMedia: ChannelMediaCapabilities = frozenMedia({
  maxFilesPerMessage: MetaMediaFilesPerMessage,
  album: { kinds: [ChannelMediaKinds.IMAGE], maxFiles: MetaMediaFilesPerMessage },
  kinds: {
    [ChannelMediaKinds.IMAGE]: {
      types: ['image/jpeg', 'image/png', 'image/gif'],
      maxBytes: 8 * MEGABYTE
    },
    [ChannelMediaKinds.VIDEO]: {
      types: ['video/mp4', 'video/ogg', 'video/x-msvideo', 'video/quicktime', 'video/webm'],
      maxBytes: 25 * MEGABYTE
    },
    [ChannelMediaKinds.AUDIO]: {
      types: ['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav'],
      maxBytes: 25 * MEGABYTE
    },
    [ChannelMediaKinds.DOCUMENT]: { types: ['application/pdf'], maxBytes: 25 * MEGABYTE }
  }
})
