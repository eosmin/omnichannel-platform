import type { MessageView } from '@platform/api-client'

import type { ThreadEntry } from './image-runs'
import { isFromCustomer, messageKindOf } from './thread-items'
import { isNoticeType } from './unsupported-kind'

// A message that may be part of a run of notices: a customer's content that the channel does not let the team see,
// with nothing else in it. One that was deleted, has a reaction, quotes another message, carries a link to open or
// a file is drawn as it always was and ends the run: its menu and its reactions are its own.
export function isRunNotice(message: MessageView): boolean {
  return (
    isFromCustomer(message) &&
    messageKindOf(message) === 'message' &&
    message.unsupportedType !== null &&
    isNoticeType(message.unsupportedType) &&
    message.reactions.length === 0 &&
    message.replyToMessageId === null &&
    message.attachmentUrl === null &&
    message.media.length === 0 &&
    message.unavailableFiles.length === 0 &&
    message.location === null &&
    message.contacts === null
  )
}

// Two or more consecutive notices of one customer are one entry, so that a customer who sends many things the
// channel does not show does not fill the thread with the same sentence. Only consecutive entries: a day, a
// message of any other kind or another author between two notices ends the run. The messages stay in the thread
// (the unread count, the order and the jump of a quote read the messages, not the entries).
export function groupNoticeRuns(entries: readonly ThreadEntry[]): ThreadEntry[] {
  const out: ThreadEntry[] = []
  let run: { messages: MessageView[]; showAuthor: boolean } | null = null
  const close = (): void => {
    if (run === null) return
    const [only] = run.messages
    const last = run.messages.at(-1)
    if (run.messages.length === 1 && only !== undefined) {
      out.push({ kind: 'message', message: only, showAuthor: run.showAuthor })
    } else if (last !== undefined) {
      out.push({ kind: 'noticeRun', messages: run.messages, last, showAuthor: run.showAuthor })
    }
    run = null
  }
  for (const entry of entries) {
    if (entry.kind === 'message' && isRunNotice(entry.message)) {
      const last: MessageView | undefined = run?.messages.at(-1)
      if (run !== null && last !== undefined && last.authorId === entry.message.authorId) {
        run.messages.push(entry.message)
        continue
      }
      close()
      run = { messages: [entry.message], showAuthor: entry.showAuthor }
      continue
    }
    close()
    out.push(entry)
  }
  close()
  return out
}
