import { CaptionState, DeliveryStatus, ResendableCaptionStates } from '@platform/core/domain'

// What the thread draws under a file of a message with several: its own text, and how that text went when
// the channel sends it as a message of its own. The first file's text is the text of the message and is drawn
// where it always was, so it is not repeated under the file.
export interface FileCaptionView {
  text: string | null
  state: 'failed' | 'unconfirmed' | 'queued' | null
}

export function fileCaptionOf(file: {
  position: number | null
  caption: string | null
  captionState: string | null
}): FileCaptionView | null {
  // A file of the customer has no place, and the text of the file at place 0 is the text of the message (the api
  // reads it the same way)
  if (file.position === null || file.position === 0) return null
  const text = file.caption === null || file.caption.trim() === '' ? null : file.caption
  const state =
    file.captionState === CaptionState.FAILED ||
    file.captionState === CaptionState.UNCONFIRMED ||
    file.captionState === CaptionState.QUEUED
      ? file.captionState
      : null
  return text === null && state === null ? null : { text, state }
}

// The file must have gone itself: a text without its file is not what the agent meant (the api refuses it)
const FILE_REACHED_THE_CHANNEL: readonly string[] = [
  DeliveryStatus.SENT,
  DeliveryStatus.DELIVERED,
  DeliveryStatus.READ
]

// A text that may be sent again: it failed (safe) or got no clear answer (the customer may then see it twice,
// so the agent is asked first), and its file went. A text on its way, or one that went, is not offered.
export function mayResendFileCaption(
  state: FileCaptionView['state'],
  fileDelivery: string | null
): state is 'failed' | 'unconfirmed' {
  return (
    state !== null &&
    ResendableCaptionStates.some(allowed => allowed === state) &&
    fileDelivery !== null &&
    FILE_REACHED_THE_CHANNEL.includes(fileDelivery)
  )
}

// Only the text that may already be with the customer asks before it is sent again
export function asksBeforeResending(state: FileCaptionView['state']): boolean {
  return state === CaptionState.UNCONFIRMED
}

export interface AlbumCaptionLine<File> {
  file: File
  // The place of the file in the album, counted from 1: the same number is drawn on its thumbnail
  number: number
  // The first file: its text is the text of the message
  isLead: boolean
}

// The texts of an album a person sent, in the order of its files (the first file first) and numbered by the
// place of each file, so every line can be matched to its thumbnail. A file with nothing to say has no line, and
// the numbers of the others do not move. `lead` says what the message itself has for the first file (its text,
// or a notice about it). An album of the customer, whose files have no place, has no such lines, and neither has
// one with fewer than two lines.
export function albumCaptionLinesOf<
  File extends { position: number | null; caption: string | null; captionState: string | null }
>(
  files: readonly File[],
  lead: { hasText: boolean; hasNotice: boolean }
): AlbumCaptionLine<File>[] {
  const placed = files.flatMap(file =>
    file.position === null ? [] : [{ file, at: file.position }]
  )
  // Places must be exactly 0..n-1, each once: otherwise a number would sit on the wrong picture, or the text of
  // the message (the first file's) would have no line to be drawn in
  const isWhole =
    placed.length === files.length && placed.every(({ at }) => at >= 0 && at < files.length)
  if (!isWhole || new Set(placed.map(({ at }) => at)).size !== files.length) return []
  const lines = placed
    .toSorted((a, b) => a.at - b.at)
    .flatMap(({ file, at }) => {
      const isLead = at === 0
      const hasLine = isLead ? lead.hasText || lead.hasNotice : fileCaptionOf(file) !== null
      return hasLine ? [{ file, number: at + 1, isLead }] : []
    })
  // A single line has nothing to be told apart from: the text stays where it always was
  return lines.length < 2 ? [] : lines
}
