import { ChannelMediaKinds, type ChannelMediaCapabilities } from '@platform/core/channel-media'
import { OutboundLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { type AlbumCandidate, albumSendBudgetMs, pickAlbum } from './album-groups'

const media: ChannelMediaCapabilities = {
  maxFilesPerMessage: 10,
  kinds: {
    [ChannelMediaKinds.IMAGE]: { types: ['image/png', 'image/jpeg'], maxBytes: 100 },
    [ChannelMediaKinds.DOCUMENT]: { types: null, maxBytes: 100 }
  },
  album: { kinds: [ChannelMediaKinds.IMAGE], maxFiles: 3 }
}

function file(index: number, over: Partial<AlbumCandidate> = {}): AlbumCandidate {
  return {
    id: `f${index}`,
    index,
    contentType: 'image/png',
    size: 10,
    isClean: true,
    wasSent: false,
    failedBefore: false,
    ...over
  }
}

const noText = (): string => ''

describe('pickAlbum', () => {
  it('takes the consecutive images from the file, in order, up to what the album holds', () => {
    const files = [0, 1, 2, 3, 4].map(index => file(index))
    const { group, rejected } = pickAlbum(files, 0, media, noText)
    expect(group.map(item => item.id)).toEqual(['f0', 'f1', 'f2'])
    expect(rejected).toEqual([])
    expect(pickAlbum(files, 3, media, noText).group.map(item => item.id)).toEqual(['f3', 'f4'])
  })

  it('stops at a file that goes apart, so the order of the message holds', () => {
    const files = [file(0), file(1), file(2, { contentType: 'application/pdf' }), file(3), file(4)]
    expect(pickAlbum(files, 0, media, noText).group.map(item => item.id)).toEqual(['f0', 'f1'])
    expect(pickAlbum(files, 3, media, noText).group.map(item => item.id)).toEqual(['f3', 'f4'])
  })

  it('steps over files that will not be sent (sent, failed before, not clean)', () => {
    const files = [
      file(0),
      file(1, { wasSent: true }),
      file(2, { failedBefore: true }),
      file(3, { isClean: false }),
      file(4)
    ]
    expect(pickAlbum(files, 0, media, noText).group.map(item => item.id)).toEqual(['f0', 'f4'])
  })

  it('leaves an image the channel refuses out, with its own code, and keeps the others', () => {
    const files = [
      file(0),
      file(1, { size: 101 }),
      file(2, { contentType: 'image/webp' }),
      file(3, { size: 0 }),
      file(4)
    ]
    const { group, rejected } = pickAlbum(files, 0, media, noText)
    expect(group.map(item => item.id)).toEqual(['f0', 'f4'])
    expect(rejected.map(item => [item.file.id, item.code])).toEqual([
      ['f1', ErrorCodes.CHANNEL_FILE_TOO_LARGE],
      ['f2', ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED],
      ['f3', ErrorCodes.CHANNEL_MESSAGE_FAILED]
    ])
  })

  it('reads the type without its parameters, as the plugin does', () => {
    const files = [file(0, { contentType: 'IMAGE/PNG; charset=binary' }), file(1)]
    expect(pickAlbum(files, 0, media, noText).group).toHaveLength(2)
  })

  it('only lets a file carry a text where the caller allows it, and stops at one that must go alone', () => {
    const files = [file(0), file(1), file(2)]
    const text = (item: AlbumCandidate): string => (item.index === 0 ? 'mira' : '')
    // The text of the first file is the album's caption
    expect(pickAlbum(files, 0, media, text, item => item.index === 0).group).toHaveLength(3)
    // Not allowed anywhere: the file with a text goes alone and the album is left empty at it
    expect(pickAlbum(files, 0, media, text, () => false).group).toEqual([])
    const second = (item: AlbumCandidate): string => (item.index === 1 ? 'dos' : '')
    expect(
      pickAlbum(files, 0, media, second, item => item.index === 0).group.map(i => i.id)
    ).toEqual(['f0'])
  })

  it('takes nothing when the channel declares no album or the kind is not in it', () => {
    const plain = { kinds: media.kinds }
    expect(pickAlbum([file(0), file(1)], 0, plain, noText).group).toEqual([])
    const docs = [
      file(0, { contentType: 'application/pdf' }),
      file(1, { contentType: 'application/pdf' })
    ]
    expect(pickAlbum(docs, 0, media, noText).group).toEqual([])
  })
})

describe('albumSendBudgetMs', () => {
  it('grows with the images, so that it never undercuts the uploads of the plugin', () => {
    expect(albumSendBudgetMs(10)).toBeGreaterThan(albumSendBudgetMs(2))
    expect(albumSendBudgetMs(2)).toBeGreaterThan(2 * OutboundLimits.ALBUM_FILE_TIMEOUT_MS)
  })

  it('covers the post of the album and the text that follows it, a call of 15 s each', () => {
    expect(albumSendBudgetMs(2) - 2 * OutboundLimits.ALBUM_FILE_TIMEOUT_MS).toBeGreaterThanOrEqual(
      2 * 15_000 + 5_000
    )
  })
})
