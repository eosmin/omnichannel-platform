import type { MessageView } from '@platform/api-client'

import { fileTargetOf, quotedFileOf, reactionsOfMessage, reactionsUnderFile } from './file-targets'

const reaction = (emoji: string, mediaId: string | null) => ({
  emoji,
  authorType: 'agent',
  authorId: 'u1',
  mediaId,
  deliveryStatus: 'sent',
  deliveryError: null
})
const file = (id: string, position: number | null) => ({
  id,
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
    ...over
  }) as unknown as Pick<MessageView, 'id' | 'authorType' | 'media' | 'reactions'>

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
})
