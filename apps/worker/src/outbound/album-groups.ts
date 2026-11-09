import {
  type ChannelMediaCapabilities,
  type MediaFileProblem,
  mediaFileProblem,
  mediaKindOfContentType
} from '@platform/core/channel-media'
import { OutboundLimits } from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'

// What the grouping needs to know of a file of a message
export interface AlbumCandidate {
  id: string
  // Its place among the files of the message, from 0
  index: number
  contentType: string
  size: number
  isClean: boolean
  wasSent: boolean
  failedBefore: boolean
}

export interface PickedAlbum<T extends AlbumCandidate> {
  // The files that go in one message, in the order of the message
  group: T[]
  // Files the channel would refuse, left out with the code that says why: the others still go
  rejected: { file: T; code: ErrorCode }[]
}

// The files that go together as one album, from `from` on. Pure: it decides, it sends and writes nothing.
//
// - Only the kinds the channel declares as an album, at most the files it says fit in one.
// - Order is the order of the message: a file that has to go apart (another kind, or one with a text of its own)
//   ends the album, so that nothing overtakes it. Files that will not be sent at all (already sent, failed on an
//   earlier attempt, not clean) are stepped over.
// - A file the channel's rules refuse (type, size) is left out with its own code, before anything is opened.
// - `allowsText` says which files may carry their text into the album (the caption of the whole album).
export function pickAlbum<T extends AlbumCandidate>(
  files: readonly T[],
  from: number,
  media: Pick<ChannelMediaCapabilities, 'kinds' | 'album'>,
  textOf: (file: T) => string,
  allowsText: (file: T) => boolean = () => false
): PickedAlbum<T> {
  const picked: PickedAlbum<T> = { group: [], rejected: [] }
  const album = media.album
  if (album === undefined) return picked
  for (const file of files.slice(from)) {
    if (file.wasSent || file.failedBefore || !file.isClean) continue
    const kind = mediaKindOfContentType(file.contentType)
    const rule = media.kinds[kind]
    if (!album.kinds.includes(kind) || rule === undefined) break
    const problem = mediaFileProblem(rule, file.contentType, file.size)
    if (problem !== null) {
      picked.rejected.push({ file, code: CODE_OF_PROBLEM[problem] })
      continue
    }
    if (textOf(file) !== '' && !allowsText(file)) break
    picked.group.push(file)
    if (picked.group.length === album.maxFiles) break
  }
  return picked
}

const CODE_OF_PROBLEM: Readonly<Record<MediaFileProblem, ErrorCode>> = {
  type: ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED,
  empty: ErrorCodes.CHANNEL_MESSAGE_FAILED,
  too_large: ErrorCodes.CHANNEL_FILE_TOO_LARGE
}

// The time an album may take: the plugin stores each image (an upload) and then posts the one message
export function albumSendBudgetMs(files: number): number {
  return files * OutboundLimits.ALBUM_FILE_TIMEOUT_MS + OutboundLimits.ALBUM_POST_TIMEOUT_MS
}
