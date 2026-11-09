import type { MessageView } from '@platform/api-client'
import { AuthorType } from '@platform/core/domain'

type Album = Pick<MessageView, 'id' | 'authorType' | 'media' | 'reactions' | 'albumNative'>

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

// A file the agent may react to or quote on its own: one of a reply of the team with several files, the first
// included, that the channel can tell from the others. The api says it (`targetable`, false for a file with no id of
// its own yet and for every file of a native album, which the provider took as ONE message): the page never guesses
// it from the channel. A message of the customer has one file each, so there is nothing to choose.
export function fileTargetOf(message: Album, fileId: string): FilePlace | null {
  if (message.authorType !== String(AuthorType.AGENT) || message.media.length < 2) return null
  if (message.albumNative) return null
  // A file with no place (the customer's) has no number to be told by
  if (message.media.some(file => file.position === null)) return null
  if (message.media.find(file => file.id === fileId)?.targetable !== true) return null
  return placeOf(message.media, fileId)
}

// Whether the buttons to answer and react are the files' and not the message's: a reply with several files whose
// first can be targeted too (the first file carries the message's own reaction, so the way to react to the message
// is never lost). Then the bar beside the bubble leaves out answer and react, and keeps the message's own actions.
export function drawsFileButtons(message: Album): boolean {
  const first = message.media.toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]
  return first !== undefined && fileTargetOf(message, first.id) !== null
}

// Whether a reaction is the one drawn under a file (the file the api resolved, which for the first file of the
// album is a reaction stored on the message), or, with no file asked, one of the message itself
export function isReactionOfFile(
  reaction: Album['reactions'][number],
  fileId: string | undefined
): boolean {
  return fileId === undefined
    ? reaction.mediaId === null
    : (reaction.fileId ?? reaction.mediaId) === fileId
}

// A reply of the team the provider took as ONE message with several files (an album of Messenger or Instagram): its
// thumbnails can be answered, which quotes the message, but never reacted to one by one: the reaction is the message's
export function isNativeAlbumOf(message: Album): boolean {
  return (
    message.albumNative &&
    message.authorType === String(AuthorType.AGENT) &&
    message.media.length >= 2
  )
}

// The file a reaction is drawn under: the one the api resolved (`fileId`, which covers the first file of an album
// with an id for each picture, whose reaction is stored on the message), else the one it names
// In a native album the reaction is the message's whatever the reaction says: no thumbnail can hold it
const fileOfReaction = (message: Album, reaction: Album['reactions'][number]): string | null =>
  message.albumNative ? null : (reaction.fileId ?? reaction.mediaId)

// The reactions left under one file of the message
export function reactionsUnderFile(message: Album, fileId: string): Album['reactions'] {
  return message.reactions.filter(reaction => fileOfReaction(message, reaction) === fileId)
}

// The reactions that belong to the message as a whole: the ones that name no file, and the ones that name a file
// the message no longer holds (none is lost)
export function reactionsOfMessage(message: Album): Album['reactions'] {
  const ids = new Set(message.media.map(file => file.id))
  return message.reactions.filter(reaction => {
    const file = fileOfReaction(message, reaction)
    return file === null || !ids.has(file)
  })
}

export interface QuotedPlace {
  number: number
  total: number | null
}

// Which file of the quoted message a reply answers, for the preview of the quote; null for a quote of the whole
// message, of a message that is not loaded, or of a file it does not hold
export function quotedFileOf(
  quoted: Pick<MessageView, 'media'> | undefined,
  mediaId: string | null,
  // Where the api says the file is in its message (from 0), for a quoted message that is not loaded: its number is
  // known and the total is not
  position?: number
): QuotedPlace | null {
  if (mediaId === null) return null
  if (quoted === undefined)
    return position === undefined ? null : { number: position + 1, total: null }
  if (quoted.media.length < 2) return null
  return placeOf(quoted.media, mediaId)
}

// The id the page gives the element of one file of an album, so that a quote of that file can find it
export const fileDomId = (mediaId: string): string => `file-${mediaId}`
