import { AuthorType, MediaStatus, MessageType } from '@platform/core/domain'

// The one place that says what state a file of the thread is in, so that the thread never shows a word where
// a box will be. The conversation list says only the kind of the last message ("Photo"): it cannot know the
// state of a file, and a text row has no box to fill, so it has no state of its own to keep in step.

export const MediaArrival = {
  // How long after a customer's message its files may still be on the way. The worker fetches them from the
  // provider after the message is stored, with retries; after this a message with no file is an old one whose
  // file is gone, and it reads as a plain word.
  WINDOW_MS: 10 * 60_000
} as const

// The kinds of message that carry a file
export const FILE_TYPES = [
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT
] as const
export type FileType = (typeof FILE_TYPES)[number]

export const isFileType = (type: string): type is FileType =>
  FILE_TYPES.some(fileType => String(fileType) === type)

// A message of a customer that is a file and has none yet: the worker stores the message first and fetches
// the file after, so for a moment there is a message without a file. That moment is drawn as the box the
// file will fill, from the first frame, instead of as a word.
export function awaitsFiles(
  message: {
    type: string
    authorType: string
    createdAt: string
    deletedAt: string | null
    media: readonly unknown[]
    unavailableFiles: readonly unknown[]
  },
  nowMs: number
): boolean {
  if (!isFileType(message.type) || message.deletedAt !== null) return false
  if (message.authorType !== String(AuthorType.CUSTOMER)) return false
  if (message.media.length > 0 || message.unavailableFiles.length > 0) return false
  const sentAt = Date.parse(message.createdAt)
  return Number.isFinite(sentAt) && nowMs - sentAt < MediaArrival.WINDOW_MS
}

// The shape of the box of a file that has not arrived: the same table as the file would use
export type PendingShape = 'image' | 'sticker' | 'pill'

export function pendingShapeOf(type: string, sticker: boolean): PendingShape {
  if (type !== String(MessageType.IMAGE)) return 'pill'
  return sticker ? 'sticker' : 'image'
}

// The states of a file that is in the database. Two of them wait (a skeleton), one is the content, three
// end in words inside the same box.
export type FileState = 'scanning' | 'loading' | 'ready' | 'infected' | 'unscannable' | 'unreadable'

export function fileStateOf(input: {
  status: string
  linksFailed: boolean
  linksRead: boolean
  // A picture that is clean whose variants are still being made
  waitingForVariants: boolean
}): FileState {
  if (input.status === String(MediaStatus.INFECTED)) return 'infected'
  if (input.status === String(MediaStatus.UNSCANNABLE)) return 'unscannable'
  if (input.status !== String(MediaStatus.CLEAN)) return 'scanning'
  if (input.linksFailed) return 'unreadable'
  if (!input.linksRead || input.waitingForVariants) return 'loading'
  return 'ready'
}

// A state that is drawn as a skeleton
export const isWaitingState = (state: FileState): boolean =>
  state === 'scanning' || state === 'loading'
