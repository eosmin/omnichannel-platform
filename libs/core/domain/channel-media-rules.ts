import { ChannelCapability, type ChannelCapabilityType } from './channel-capability'

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
