import { MetaMessaging } from './meta-constants'

const MEGABYTE = 1024 * 1024

// The kinds of attachment the Send API of Messenger and Instagram names
export type MetaMediaKind =
  | typeof MetaMessaging.ATTACHMENT_IMAGE
  | typeof MetaMessaging.ATTACHMENT_VIDEO
  | typeof MetaMessaging.ATTACHMENT_AUDIO
  | typeof MetaMessaging.ATTACHMENT_FILE

// What one channel takes for a kind of file. `types` is the list of content types the channel accepts, or
// null when Meta's reference names no list (then the types the platform lets be uploaded are the only
// filter). `maxBytes` is the largest file, which is smaller than what the platform stores for some kinds.
export interface MetaMediaRule {
  readonly types: readonly string[] | null
  readonly maxBytes: number
}

export type MetaMediaRules = Readonly<Record<MetaMediaKind, MetaMediaRule>>

// Meta, "Saving assets" (Messenger Platform): 8 MB for an image and 25 MB for any other file. The page lists
// no formats, so none is filtered here; Meta answers 100/2018047 for a type that does not match the file.
export const MessengerMediaRules: MetaMediaRules = {
  [MetaMessaging.ATTACHMENT_IMAGE]: { types: null, maxBytes: 8 * MEGABYTE },
  [MetaMessaging.ATTACHMENT_VIDEO]: { types: null, maxBytes: 25 * MEGABYTE },
  [MetaMessaging.ATTACHMENT_AUDIO]: { types: null, maxBytes: 25 * MEGABYTE },
  [MetaMessaging.ATTACHMENT_FILE]: { types: null, maxBytes: 25 * MEGABYTE }
}

// Meta, "Upload Media for Instagram Messaging" and "Send a message" (Instagram Messaging, read 2026-11-07):
// image png/jpeg/gif up to 8 MB; audio aac/m4a/wav/mp4 up to 25 MB; video mp4/ogg/avi/mov/webm up to 25 MB;
// file: pdf only, up to 25 MB.
export const InstagramMediaRules: MetaMediaRules = {
  [MetaMessaging.ATTACHMENT_IMAGE]: {
    types: ['image/jpeg', 'image/png', 'image/gif'],
    maxBytes: 8 * MEGABYTE
  },
  [MetaMessaging.ATTACHMENT_VIDEO]: {
    types: ['video/mp4', 'video/ogg', 'video/x-msvideo', 'video/quicktime', 'video/webm'],
    maxBytes: 25 * MEGABYTE
  },
  [MetaMessaging.ATTACHMENT_AUDIO]: {
    types: ['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav'],
    maxBytes: 25 * MEGABYTE
  },
  [MetaMessaging.ATTACHMENT_FILE]: { types: ['application/pdf'], maxBytes: 25 * MEGABYTE }
}
