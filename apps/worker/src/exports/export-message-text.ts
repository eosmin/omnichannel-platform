// The text of a message as the export writes it: the text of the message, then the text under each of its files
// in their order, one per line. Unless the text of the message went apart (`textApart`), the text under the first
// file IS the text of the message (a copy that an edit leaves stale), so it is not written a second time.
export function exportMessageText(message: {
  content: string | null
  textApart: boolean
  media: readonly { position: number | null; caption: string | null }[]
}): string | null {
  const underFiles = message.media
    .filter(file => message.textApart || (file.position ?? 0) > 0)
    .map(file => file.caption)
  const texts = [message.content, ...underFiles].filter(
    (text): text is string => text !== null && text.trim() !== ''
  )
  return texts.length === 0 ? message.content : texts.join('\n')
}
