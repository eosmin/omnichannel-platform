// The text the thread draws under a file of a message with several. The first file's text is the text of the
// message and is drawn where it always was (or first in the list of an album), so it is not repeated under the
// file. A file of the customer has no place and no text of its own.
export function fileCaptionOf(file: {
  position: number | null
  caption: string | null
}): string | null {
  // The text of the file at place 0 is the text of the message (the api reads it the same way)
  if (file.position === null || file.position === 0) return null
  return file.caption === null || file.caption.trim() === '' ? null : file.caption
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
  File extends { position: number | null; caption: string | null }
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
