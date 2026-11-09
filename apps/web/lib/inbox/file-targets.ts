import type { MessageView } from '@platform/api-client'
import { AuthorType } from '@platform/core/domain'

type Album = Pick<MessageView, 'id' | 'authorType' | 'media' | 'reactions'>

// Where a file stands among the files of its message: the number of its thumbnail and how many there are
export interface FilePlace {
  number: number
  total: number
}

// The number is the order of the file among the files of the message (by place), so it never passes the total even
// when a place is missing; it is the number of its thumbnail whenever the places are whole
const placeOf = (media: Album['media'], id: string): FilePlace | null => {
  const ordered = media.toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const index = ordered.findIndex(file => file.id === id)
  return index === -1 ? null : { number: index + 1, total: ordered.length }
}

// A file the agent may react to or quote on its own: one of a reply of the team with several files, after the
// first (the first IS the message: its reaction and its quote are the message's). Whether the channel can tell the
// file from the message is the api's to say: when it cannot, it answers with the message's, and the reaction is
// drawn there. A message of the customer has one file each, so there is nothing to choose.
export function fileTargetOf(message: Album, fileId: string): FilePlace | null {
  if (message.authorType !== String(AuthorType.AGENT) || message.media.length < 2) return null
  // A file with no place (the customer's) has no number to be told by
  if (message.media.some(file => file.position === null)) return null
  const place = placeOf(message.media, fileId)
  return place === null || place.number === 1 ? null : place
}

// The reactions left under one file of the message, by the file they name
export function reactionsUnderFile(message: Album, fileId: string): Album['reactions'] {
  return message.reactions.filter(reaction => reaction.mediaId === fileId)
}

// The reactions that belong to the message as a whole: the ones that name no file, and the ones that name a file
// the message no longer holds (none is lost)
export function reactionsOfMessage(message: Album): Album['reactions'] {
  const ids = new Set(message.media.map(file => file.id))
  return message.reactions.filter(
    reaction => reaction.mediaId === null || !ids.has(reaction.mediaId)
  )
}

// Which file of the quoted message a reply answers, for the preview of the quote; null for a quote of the whole
// message, of a message that is not loaded, or of a file it does not hold
export function quotedFileOf(
  quoted: Pick<MessageView, 'media'> | undefined,
  mediaId: string | null
): FilePlace | null {
  if (quoted === undefined || mediaId === null || quoted.media.length < 2) return null
  return placeOf(quoted.media, mediaId)
}
