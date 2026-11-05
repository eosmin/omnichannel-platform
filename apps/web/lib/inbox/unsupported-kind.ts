// What the thread says about a message whose text is only the marker a channel stores for a type it
// cannot read. The provider's word (`story_mention`, `image`) never reaches the screen: it picks one of a
// few translated sentences. A media type here means the file could not be fetched (a link the server
// refused), not that the channel cannot show images.
export type UnsupportedKind = 'storyMention' | 'share' | 'location' | 'media' | 'other'

const KINDS = new Map<string, UnsupportedKind>([
  ['story_mention', 'storyMention'],
  ['location', 'location'],
  ['share', 'share'],
  ['ig_post', 'share'],
  ['ig_reel', 'share'],
  ['reel', 'share'],
  ['post', 'share'],
  ['image', 'media'],
  ['video', 'media'],
  ['audio', 'media'],
  ['file', 'media'],
  ['document', 'media'],
  ['sticker', 'media']
])

export const unsupportedKindOf = (type: string): UnsupportedKind => KINDS.get(type) ?? 'other'

// The text a bubble draws as the words of the message, or null when it draws something else in their
// place: a deleted message has none, a location is drawn as its card, and a marker is a sentence
export function bubbleTextOf(message: {
  content: string | null
  hasLocation: boolean
  unsupportedType: string | null
}): string | null {
  if (message.content === null || message.content === '') return null
  return message.hasLocation || message.unsupportedType !== null ? null : message.content
}
