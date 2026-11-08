import type { MessageView } from '@platform/api-client'
import { MediaStatus, MessageType } from '@platform/core/domain'

import { mediaKindOf } from './media-kind'
import { isFromCustomer, messageKindOf, type ThreadItem } from './thread-items'

// Pictures a customer sends one after the other arrive as one message each (each has its own id at the channel),
// so they are put together only to be drawn: a run is one block with a cell for each picture, and every picture
// keeps its message (its hour, its reactions, its quote, its menu).
export const IMAGE_RUN_WINDOW_MS = 60_000

export type ThreadEntry =
  ThreadItem | { kind: 'imageRun'; messages: readonly MessageView[]; showAuthor: boolean }

// A message that may be part of a run: a customer's single picture, with nothing else in it. A caption, a quote,
// a link, a sticker, a deleted one, one whose file is not clean or not stored yet, anything that is not a picture:
// each is drawn as it always was, and ends the run.
export function isRunImage(message: MessageView): boolean {
  const [file] = message.media
  return (
    isFromCustomer(message) &&
    messageKindOf(message) === 'media' &&
    message.type === String(MessageType.IMAGE) &&
    !message.sticker &&
    message.media.length === 1 &&
    file !== undefined &&
    file.status === MediaStatus.CLEAN &&
    mediaKindOf(message.type, file.contentType) === MessageType.IMAGE &&
    message.unavailableFiles.length === 0 &&
    (message.content === null || message.content.trim() === '') &&
    message.replyToMessageId === null &&
    message.attachmentUrl === null &&
    message.location === null &&
    message.contacts === null &&
    message.unsupportedType === null
  )
}

const gapMs = (before: MessageView, after: MessageView): number =>
  new Date(after.createdAt).getTime() - new Date(before.createdAt).getTime()

// Within the window and not before: a date that does not read, or a picture that is older than the one before it,
// does not join (a gap that is NaN or negative is no gap)
const isWithinWindow = (gap: number): boolean =>
  Number.isFinite(gap) && gap >= 0 && gap <= IMAGE_RUN_WINDOW_MS

// Runs of two or more consecutive pictures of one customer, each within a minute of the one before. Only
// consecutive: a day separator, a message of another kind or of another author between two pictures ends the run.
export function groupImageRuns(items: readonly ThreadItem[]): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  let run: { messages: MessageView[]; showAuthor: boolean } | null = null
  const close = (): void => {
    if (run === null) return
    const [only] = run.messages
    if (run.messages.length === 1 && only !== undefined) {
      entries.push({ kind: 'message', message: only, showAuthor: run.showAuthor })
    } else {
      entries.push({ kind: 'imageRun', messages: run.messages, showAuthor: run.showAuthor })
    }
    run = null
  }
  for (const item of items) {
    if (item.kind === 'message' && isRunImage(item.message)) {
      const last: MessageView | undefined = run?.messages.at(-1)
      const joins =
        run !== null &&
        last !== undefined &&
        last.authorId === item.message.authorId &&
        isWithinWindow(gapMs(last, item.message))
      if (joins && run !== null) {
        run.messages.push(item.message)
        continue
      }
      close()
      run = { messages: [item.message], showAuthor: item.showAuthor }
      continue
    }
    close()
    entries.push(item)
  }
  close()
  return entries
}
