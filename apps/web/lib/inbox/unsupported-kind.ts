// What the thread says about a message whose text is only the marker a channel stores for a type it
// cannot read. The provider's word (`story_mention`, `image`) never reaches the screen: it picks one of a
// few translated sentences. A media type here means the file could not be fetched (a link the server
// refused), not that the channel cannot show images.
// `unsupported` is the type the channel stores when the provider itself sends the message with no content
// (a sticker or a like of Instagram): there is nothing to show, and the team is told to open the app.
export type UnsupportedKind =
  'storyMention' | 'share' | 'location' | 'media' | 'notDelivered' | 'other'

export const unsupportedKindOf = (type: string): UnsupportedKind =>
  type === 'story_mention'
    ? 'storyMention'
    : type === 'location'
      ? 'location'
      : type === 'unsupported'
        ? 'notDelivered'
        : /^(share|ig_post|ig_reel|reel|post)$/.test(type)
          ? 'share'
          : /^(image|video|audio|file|document|sticker)$/.test(type)
            ? 'media'
            : 'other'

// The text a bubble draws as the words of the message, or null when it draws something else in their
// place: a deleted message has none, a location is drawn as its card, and a marker is a sentence
export function bubbleTextOf(message: {
  content: string | null
  hasLocation: boolean
  // The cards already show the names, which are the content of the message
  hasContacts?: boolean
  unsupportedType: string | null
}): string | null {
  if (message.content === null || message.content === '') return null
  return message.hasLocation || message.hasContacts === true || message.unsupportedType !== null
    ? null
    : message.content
}
