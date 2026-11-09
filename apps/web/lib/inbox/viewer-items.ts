import { MediaStatus, MessageType } from '@platform/core/domain'

import { mediaKindOf } from './media-kind'

// A picture the viewer can walk: the id of the file the links are read for, its name, the text under it and its
// number (the one its thumbnail wears: its place in the message or the block, counted from 1). `key` is what the
// caller opens it by (the file of an album, or the message of a run of pictures).
export interface ViewerItem {
  key: string
  mediaId: string
  filename: string
  caption: string | null
  number: number
}

interface ViewerFile {
  id: string
  filename: string
  contentType: string
  status: string
  position: number | null
  caption: string | null
}

const isWalkable = (file: ViewerFile, messageType: string): boolean =>
  file.status === String(MediaStatus.CLEAN) &&
  mediaKindOf(messageType, file.contentType) === MessageType.IMAGE

const captionOf = (file: ViewerFile): string | null => {
  const text = file.caption?.trim() ?? ''
  return text === '' ? null : text
}

// The pictures of a message, in the order of the message, for the viewer to walk with the arrows. Only a picture
// that is clean: a video, a document or a file still being scanned has no large variant to show. The text is the
// one the view holds for the file (blank is none): for the first file that is the text of the message unless it
// went apart, which is the text the thread draws for the picture too. A picture that the decoder refused (no
// variants) is not known here: it opens its original (a debt in the plan).
export function viewerItemsOf(files: readonly ViewerFile[], messageType: string): ViewerItem[] {
  return files
    .map((file, at) => ({ file, number: (file.position ?? at) + 1 }))
    .filter(({ file }) => isWalkable(file, messageType))
    .toSorted((a, b) => a.number - b.number)
    .map(({ file, number }) => ({
      key: file.id,
      mediaId: file.id,
      filename: file.filename,
      caption: captionOf(file),
      number
    }))
}

// The pictures of a block of consecutive pictures of a customer (each its own message): the first file of each,
// keyed by the message, so the arrows walk the block and never land on a file with no links
export function viewerItemsOfRun(
  messages: readonly { id: string; type: string; media: readonly ViewerFile[] }[]
): ViewerItem[] {
  return messages.flatMap((message, at) => {
    const [file] = message.media
    return file === undefined || !isWalkable(file, message.type)
      ? []
      : [
          {
            key: message.id,
            mediaId: file.id,
            filename: file.filename,
            caption: captionOf(file),
            number: at + 1
          }
        ]
  })
}

// The picture the arrows lead to, coming round at the ends; null when the one open is not in the list
export function stepViewerKey(
  items: readonly ViewerItem[],
  key: string,
  by: number
): string | null {
  const index = items.findIndex(item => item.key === key)
  if (index === -1) return null
  return items[(index + by + items.length) % items.length]?.key ?? null
}
