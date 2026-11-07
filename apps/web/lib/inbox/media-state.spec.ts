import { AuthorType, MediaStatus, MessageType } from '@platform/core/domain'

import {
  awaitsFiles,
  fileStateOf,
  isWaitingState,
  MediaArrival,
  pendingShapeOf
} from './media-state'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const secondsAgo = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString()

const message = (
  over: Partial<Parameters<typeof awaitsFiles>[0]> = {}
): Parameters<typeof awaitsFiles>[0] => ({
  type: MessageType.IMAGE,
  authorType: AuthorType.CUSTOMER,
  createdAt: secondsAgo(2),
  deletedAt: null,
  media: [],
  unavailableFiles: [],
  ...over
})

describe('awaitsFiles', () => {
  it('is true for a customer picture stored a moment ago with no file yet', () => {
    expect(awaitsFiles(message(), NOW)).toBe(true)
  })

  it.each([MessageType.VIDEO, MessageType.AUDIO, MessageType.DOCUMENT])(
    'is true for a %s',
    type => {
      expect(awaitsFiles(message({ type }), NOW)).toBe(true)
    }
  )

  it('is false for text, for a reply of an agent and for a deleted message', () => {
    expect(awaitsFiles(message({ type: MessageType.TEXT }), NOW)).toBe(false)
    expect(awaitsFiles(message({ authorType: AuthorType.AGENT }), NOW)).toBe(false)
    expect(awaitsFiles(message({ deletedAt: secondsAgo(1) }), NOW)).toBe(false)
  })

  it('is false once a file, or the words for a file that was lost, are there', () => {
    expect(awaitsFiles(message({ media: [{}] }), NOW)).toBe(false)
    expect(awaitsFiles(message({ unavailableFiles: [{}] }), NOW)).toBe(false)
  })

  it('stops waiting after the window, so an old message with no file reads as a word', () => {
    const edge = MediaArrival.WINDOW_MS / 1000
    expect(awaitsFiles(message({ createdAt: secondsAgo(edge - 1) }), NOW)).toBe(true)
    expect(awaitsFiles(message({ createdAt: secondsAgo(edge) }), NOW)).toBe(false)
  })

  it('is false for a date it cannot read', () => {
    expect(awaitsFiles(message({ createdAt: 'not a date' }), NOW)).toBe(false)
  })
})

describe('pendingShapeOf', () => {
  it('uses the box of the file that will come', () => {
    expect(pendingShapeOf(MessageType.IMAGE, false)).toBe('image')
    expect(pendingShapeOf(MessageType.IMAGE, true)).toBe('sticker')
    expect(pendingShapeOf(MessageType.VIDEO, false)).toBe('pill')
    expect(pendingShapeOf(MessageType.AUDIO, false)).toBe('pill')
    expect(pendingShapeOf(MessageType.DOCUMENT, false)).toBe('pill')
  })
})

describe('fileStateOf', () => {
  const clean = {
    status: MediaStatus.CLEAN,
    linksFailed: false,
    linksRead: true,
    waitingForVariants: false
  }

  it('goes from scanning, to loading, to ready, with no state that is a word in between', () => {
    expect(fileStateOf({ ...clean, status: MediaStatus.PENDING })).toBe('scanning')
    expect(fileStateOf({ ...clean, linksRead: false })).toBe('loading')
    expect(fileStateOf({ ...clean, waitingForVariants: true })).toBe('loading')
    expect(fileStateOf(clean)).toBe('ready')
  })

  it('ends in words for an infected file, one that could not be scanned and links that failed', () => {
    expect(fileStateOf({ ...clean, status: MediaStatus.INFECTED })).toBe('infected')
    expect(fileStateOf({ ...clean, status: MediaStatus.UNSCANNABLE })).toBe('unscannable')
    expect(fileStateOf({ ...clean, linksFailed: true })).toBe('unreadable')
  })

  it('reads a status of a newer server as a file still being scanned', () => {
    expect(fileStateOf({ ...clean, status: 'SOMETHING_NEW' })).toBe('scanning')
  })

  it('draws a skeleton in the waiting states only', () => {
    expect(isWaitingState('scanning')).toBe(true)
    expect(isWaitingState('loading')).toBe(true)
    for (const state of ['ready', 'infected', 'unscannable', 'unreadable'] as const) {
      expect(isWaitingState(state)).toBe(false)
    }
  })
})
