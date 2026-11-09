import type { MessageView } from '@platform/api-client'

import {
  fileTargetOf,
  isNativeAlbumOf,
  quotedFileOf,
  reactionsOfMessage,
  reactionsUnderFile
} from './file-targets'

const reaction = (emoji: string, mediaId: string | null, fileId: string | null = mediaId) => ({
  emoji,
  authorType: 'agent',
  authorId: 'u1',
  mediaId,
  fileId,
  deliveryStatus: 'sent',
  deliveryError: null
})
const file = (id: string, position: number | null, targetable = true) => ({
  id,
  targetable,
  filename: `${id}.png`,
  contentType: 'image/png',
  position
})
const album = (over: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    authorType: 'agent',
    media: [file('a', 0), file('b', 1), file('c', 2)],
    reactions: [],
    albumNative: false,
    ...over
  }) as unknown as Pick<MessageView, 'id' | 'authorType' | 'media' | 'reactions' | 'albumNative'>

describe('fileTargetOf', () => {
  it('is the number of the file among the files, for a file after the first of a reply with several', () => {
    const message = album()

    expect(fileTargetOf(message, 'b')).toEqual({ number: 2, total: 3 })
    expect(fileTargetOf(message, 'c')).toEqual({ number: 3, total: 3 })
  })

  it('is none for the first file (it is the message), a lone file, or a file of the customer', () => {
    expect(fileTargetOf(album(), 'a')).toBeNull()
    expect(fileTargetOf(album({ media: [file('a', 0)] }), 'a')).toBeNull()
    expect(fileTargetOf(album({ media: [file('a', null), file('b', null)] }), 'b')).toBeNull()
    expect(fileTargetOf(album(), 'zzz')).toBeNull()
  })

  it('is none for a message of the customer: only what the team sent has files to target', () => {
    expect(fileTargetOf(album({ authorType: 'customer' }), 'b')).toBeNull()
  })
})

describe('files the channel cannot tell apart', () => {
  it('offers no file of a native album to react to or quote on its own, even if the api marked them', () => {
    const native = album({ albumNative: true })

    expect(fileTargetOf(native, 'b')).toBeNull()
    expect(fileTargetOf(native, 'c')).toBeNull()
    expect(isNativeAlbumOf(native)).toBe(true)
  })

  it('offers no file that is not targetable (no id at the provider yet)', () => {
    const message = album({ media: [file('a', 0), file('b', 1, false), file('c', 2)] })

    expect(fileTargetOf(message, 'b')).toBeNull()
    expect(fileTargetOf(message, 'c')).toEqual({ number: 3, total: 3 })
  })

  it('knows a native album only for the team: a message of the customer has none', () => {
    expect(isNativeAlbumOf(album({ albumNative: true, authorType: 'customer' }))).toBe(false)
    expect(isNativeAlbumOf(album({ albumNative: true, media: [file('a', 0)] }))).toBe(false)
    expect(isNativeAlbumOf(album())).toBe(false)
  })
})

describe('numbers of files with gaps in their places', () => {
  it('counts the files in order, so the number never passes the total', () => {
    const message = album({ media: [file('a', 0), file('b', 2), file('c', 3)] })

    expect(fileTargetOf(message, 'b')).toEqual({ number: 2, total: 3 })
    expect(fileTargetOf(message, 'c')).toEqual({ number: 3, total: 3 })
    expect(quotedFileOf(message, 'c')).toEqual({ number: 3, total: 3 })
  })
})

describe('reactionsUnderFile and reactionsOfMessage', () => {
  const reactions = [
    reaction('x', null),
    reaction('y', 'b'),
    reaction('z', 'c'),
    reaction('w', 'gone')
  ]
  const message = album({ reactions })

  it('draws a reaction under the file it names', () => {
    expect(reactionsUnderFile(message, 'b').map(item => item.emoji)).toEqual(['y'])
    expect(reactionsUnderFile(message, 'a')).toEqual([])
  })

  it('draws the reaction the api resolved to the first file under it, not under the message', () => {
    const first = album({ reactions: [reaction('f', null, 'a'), reaction('m', null, null)] })

    expect(reactionsUnderFile(first, 'a').map(item => item.emoji)).toEqual(['f'])
    expect(reactionsOfMessage(first).map(item => item.emoji)).toEqual(['m'])
  })

  it('keeps every reaction of a native album with the message, whatever file it names', () => {
    const native = album({ albumNative: true, reactions: [reaction('n', null, 'a')] })

    expect(reactionsUnderFile(native, 'a')).toEqual([])
    expect(reactionsOfMessage(native).map(item => item.emoji)).toEqual(['n'])
  })

  it('keeps with the message a reaction resolved to a file it no longer holds', () => {
    const gone = album({ reactions: [reaction('g', null, 'gone')] })

    expect(reactionsOfMessage(gone).map(item => item.emoji)).toEqual(['g'])
  })

  it('leaves to the message the ones that name no file of it, so none is lost', () => {
    expect(reactionsOfMessage(message).map(item => item.emoji)).toEqual(['x', 'w'])
  })
})

describe('quotedFileOf', () => {
  const quoted = album()

  it('says which file of the quoted message a reply answers', () => {
    expect(quotedFileOf(quoted, 'c')).toEqual({ number: 3, total: 3 })
    expect(quotedFileOf(quoted, 'b')).toEqual({ number: 2, total: 3 })
  })

  it('says nothing for a quote of the message, a message that is not loaded, or a file it does not have', () => {
    expect(quotedFileOf(quoted, null)).toBeNull()
    expect(quotedFileOf(undefined, 'c')).toBeNull()
    expect(quotedFileOf(quoted, 'zzz')).toBeNull()
  })

  it('knows the number but not the total when the quoted message is not loaded and the api gave the place', () => {
    expect(quotedFileOf(undefined, 'c', 3)).toEqual({ number: 4, total: null })
    expect(quotedFileOf(undefined, null, 3)).toBeNull()
  })
})
