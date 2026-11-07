import type { MessageView } from '@platform/api-client'
import { MediaStatus, MessageType } from '@platform/core/domain'
import { mediaMessageTypeOf } from '@platform/core/storage'

import type { MessageKind } from './thread-items'

// A sticker is drawn alone, with no bubble around it. One that quotes, carries words or a link keeps its
// bubble, because those need something to sit in; so does one whose file ended in a state that says
// words (infected, not scannable, not kept), which would otherwise float over the thread, and one whose
// file is not a picture (the box of a sticker is a picture's).
export function drawsWithoutBubble(
  message: Pick<MessageView, 'sticker' | 'content' | 'replyToMessageId' | 'attachmentUrl'> & {
    media: readonly Pick<MessageView['media'][number], 'status' | 'contentType'>[]
    unavailableFiles: readonly unknown[]
  },
  kind: MessageKind,
  // The file of the sticker has not been stored yet: its box is already the one of a sticker
  awaiting = false
): boolean {
  return (
    message.sticker &&
    kind !== 'deleted' &&
    kind !== 'note' &&
    (awaiting ||
      (message.media.length > 0 &&
        message.media.every(
          file =>
            file.status !== MediaStatus.INFECTED &&
            file.status !== MediaStatus.UNSCANNABLE &&
            mediaMessageTypeOf(file.contentType) === MessageType.IMAGE
        ) &&
        message.unavailableFiles.length === 0)) &&
    message.replyToMessageId === null &&
    message.attachmentUrl === null &&
    (message.content === null || message.content === '')
  )
}
