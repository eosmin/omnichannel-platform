// What the thread says about a message whose text is only the marker a channel stores for a type it
// cannot read. The provider's word (`story_mention`, `image`) never reaches the screen: it picks one of a
// few translated sentences. A media type here means the file could not be fetched (a link the server
// refused), not that the channel cannot show images.
export const UnsupportedKinds = {
  STORY_MENTION: 'storyMention',
  SHARE: 'share',
  LOCATION: 'location',
  MEDIA: 'media',
  OTHER: 'other'
} as const

export type UnsupportedKind = (typeof UnsupportedKinds)[keyof typeof UnsupportedKinds]

const MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image',
  'video',
  'audio',
  'file',
  'document',
  'sticker'
])
const SHARE_TYPES: ReadonlySet<string> = new Set(['share', 'ig_post', 'ig_reel', 'reel', 'post'])

export function unsupportedKindOf(type: string): UnsupportedKind {
  if (type === 'story_mention') return UnsupportedKinds.STORY_MENTION
  if (type === 'location') return UnsupportedKinds.LOCATION
  if (SHARE_TYPES.has(type)) return UnsupportedKinds.SHARE
  if (MEDIA_TYPES.has(type)) return UnsupportedKinds.MEDIA
  return UnsupportedKinds.OTHER
}

// The text a bubble draws as the words of the message, or null when it draws something else in their
// place: a deleted message has none, a location is drawn as its card, and a marker is a sentence
export function bubbleTextOf(message: {
  content: string | null
  hasLocation: boolean
  unsupportedType: string | null
}): string | null {
  if (message.content === null || message.content === '') return null
  if (message.hasLocation || message.unsupportedType !== null) return null
  return message.content
}
