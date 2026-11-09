// What the thread says about a message whose text is only the marker a channel stores for a type it
// cannot read. The provider's word never reaches the screen, and this page knows no channel and no form of one
// provider: every content the channel does not let the team see is ONE sentence (`notice`), the same for all
// channels, and consecutive ones are drawn as one bubble (`notice-runs.ts`). A media type here means the file
// could not be fetched (a link the server refused), not that the channel cannot show images.
export type UnsupportedKind = 'media' | 'notice'

export const unsupportedKindOf = (type: string): UnsupportedKind =>
  /^(image|video|audio|file|document|sticker)$/.test(type) ? 'media' : 'notice'

// Content the channel does not let the team see (what the notices say), as opposed to a file that failed to arrive
export const isNoticeType = (type: string): boolean => unsupportedKindOf(type) === 'notice'

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
