import { ChannelCapability, type ChannelCapabilityType } from '../channel-capability'

// The kinds of file a channel may take in a message, by the name the platform uses for them
export const ChannelMediaKinds = {
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document'
} as const
export type ChannelMediaKind = (typeof ChannelMediaKinds)[keyof typeof ChannelMediaKinds]

// The capability a channel declares for each kind of file: the rule of a kind exists exactly when the
// channel declares the capability (the registry checks both ways)
export const CapabilityOfMediaKind: Readonly<Record<ChannelMediaKind, ChannelCapabilityType>> = {
  [ChannelMediaKinds.IMAGE]: ChannelCapability.IMAGE,
  [ChannelMediaKinds.VIDEO]: ChannelCapability.VIDEO,
  [ChannelMediaKinds.AUDIO]: ChannelCapability.AUDIO,
  [ChannelMediaKinds.DOCUMENT]: ChannelCapability.DOCUMENT
}

// What one channel takes for one kind of file. `types` is the list of content types the channel
// accepts, or null when the provider publishes no list (the types the platform lets be uploaded are then
// the only filter). `maxBytes` is the largest file of that kind.
export interface ChannelMediaRule {
  readonly types: readonly string[] | null
  readonly maxBytes: number
}

export type ChannelMediaRules = Readonly<Partial<Record<ChannelMediaKind, ChannelMediaRule>>>

// What a channel says about the files it takes. The platform reads it to refuse a file before a message is
// queued and the plugin reads it to refuse one before it is opened: one declaration for both.
export interface ChannelMediaCapabilities {
  // Files in one message. 1 until the platform sends several in order (a channel that must send one message
  // per file still declares how many the agent may attach).
  readonly maxFilesPerMessage: number
  readonly kinds: ChannelMediaRules
}

// Files in one message on the channels of Meta, which send them one by one in the order the agent gave. A
// number the platform chose (WhatsApp, Messenger and Instagram publish none): it only counts while
// `OUTBOUND_MULTI_FILE_ENABLED` is on, and the real test with each provider decides whether it stays.
export const MetaMediaFilesPerMessage = 10

// `image/jpeg; charset=binary` is `image/jpeg`: the type without its parameters, in lower case
export function bareContentType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

// The kind of file for a content type: images, videos and audios by their family, and anything else is a document.
// The one rule for the core and the plugins, so that none of them decides on its own what a message may hold.
export function mediaKindOfContentType(contentType: string): ChannelMediaKind {
  const type = bareContentType(contentType)
  if (type.startsWith('image/')) return ChannelMediaKinds.IMAGE
  if (type.startsWith('video/')) return ChannelMediaKinds.VIDEO
  if (type.startsWith('audio/')) return ChannelMediaKinds.AUDIO
  return ChannelMediaKinds.DOCUMENT
}

// Why a channel's rules refuse a file, or null when they take it. The one check for the worker (before it opens
// anything) and for the plugins (before they send), so that the two cannot drift: `type` is a type the channel does
// not list, `empty` a size that is not a positive whole number, `too_large` a size over the largest of its kind.
export type MediaFileProblem = 'type' | 'empty' | 'too_large'

export function mediaFileProblem(
  rule: ChannelMediaRule,
  contentType: string,
  size: number
): MediaFileProblem | null {
  const type = bareContentType(contentType)
  if (rule.types !== null && !rule.types.includes(type)) return 'type'
  if (!Number.isSafeInteger(size) || size <= 0) return 'empty'
  if (size > rule.maxBytes) return 'too_large'
  return null
}

export const ChannelMediaLimits = {
  // What no declaration may exceed: the registry refuses a plugin that asks for more
  MAX_FILES_PER_MESSAGE: 30,
  MAX_BYTES: 100 * 1024 * 1024,
  // A list of types longer than this is not a list of formats
  MAX_TYPES: 50,
  MAX_TYPE_LENGTH: 100
} as const

// A declaration that nobody can change afterwards: the constants of the channels are shared by every importer,
// and a list that grows after boot would change what a plugin accepts while the registry's copy says otherwise
export function frozenMedia(media: ChannelMediaCapabilities): ChannelMediaCapabilities {
  const kinds: Partial<Record<ChannelMediaKind, ChannelMediaRule>> = {}
  for (const kind of Object.values(ChannelMediaKinds)) {
    const rule = media.kinds[kind]
    if (rule !== undefined) {
      kinds[kind] = Object.freeze({
        types: rule.types === null ? null : Object.freeze([...rule.types]),
        maxBytes: rule.maxBytes
      })
    }
  }
  return Object.freeze({
    maxFilesPerMessage: media.maxFilesPerMessage,
    kinds: Object.freeze(kinds)
  })
}
