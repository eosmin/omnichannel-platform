import { DeliveryStatus, MessageType } from '@platform/core/domain'

import { mediaKindOf } from './media-kind'

interface AlbumFile {
  contentType: string
  delivery: string | null
}

// Several pictures in one message are drawn as a grid; anything else (a video, a document, a voice note, a
// lone picture, a sticker) stays in the list the thread always drew. A mix of kinds comes only from a customer.
export function isAlbum(
  files: readonly AlbumFile[],
  messageType: string,
  sticker: boolean
): boolean {
  return (
    !sticker &&
    files.length > 1 &&
    files.every(file => mediaKindOf(messageType, file.contentType) === MessageType.IMAGE)
  )
}

// What is said about one file of a reply, by the state the api gives it: only what the agent has to act on or wait
// for. A file that went out is told by the ticks of the message; a customer's file, or a reply from before the
// state was kept per file, has none.
export type FileDelivery = 'queued' | 'failed'

export function fileDeliveryOf(file: { delivery: string | null }): FileDelivery | null {
  if (file.delivery === String(DeliveryStatus.FAILED)) return 'failed'
  return file.delivery === String(DeliveryStatus.QUEUED) ? 'queued' : null
}

// Whether to say, under the files, that "send again" sends only the ones that failed: when some did and the rest
// did not, so the agent does not fear a second copy of the pictures that arrived
export function sayRetryOnlyFailed(files: readonly { delivery: string | null }[]): boolean {
  const failed = files.filter(file => fileDeliveryOf(file) === 'failed').length
  return failed > 0 && failed < files.length
}
