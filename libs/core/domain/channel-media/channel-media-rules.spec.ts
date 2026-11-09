import {
  bareContentType,
  ChannelMediaKinds,
  frozenMedia,
  mediaFileProblem,
  mediaKindOfContentType
} from './channel-media-rules'

describe('frozenMedia', () => {
  it('copies and freezes, so the constants of a channel cannot be changed by whoever imports them', () => {
    const types = ['image/png']
    const media = frozenMedia({
      maxFilesPerMessage: 1,
      kinds: { [ChannelMediaKinds.IMAGE]: { types, maxBytes: 1024 } }
    })

    types.push('image/svg+xml')

    expect(media.kinds.image?.types).toEqual(['image/png'])
    expect(Object.isFrozen(media)).toBe(true)
    expect(Object.isFrozen(media.kinds)).toBe(true)
    expect(Object.isFrozen(media.kinds.image)).toBe(true)
    expect(Object.isFrozen(media.kinds.image?.types)).toBe(true)
    expect(() => (media.kinds.image?.types as string[]).push('x')).toThrow()
  })

  it('keeps a kind with no list of types as null and leaves out a kind with no rule', () => {
    const media = frozenMedia({
      maxFilesPerMessage: 1,
      kinds: { [ChannelMediaKinds.DOCUMENT]: { types: null, maxBytes: 5 } }
    })
    expect(media.kinds.document).toEqual({ types: null, maxBytes: 5 })
    expect(media.kinds.image).toBeUndefined()
  })
})

describe('bareContentType', () => {
  it('drops the parameters and the case, and trims', () => {
    expect(bareContentType(' IMAGE/PNG; charset=binary')).toBe('image/png')
    expect(bareContentType('')).toBe('')
  })
})

describe('mediaKindOfContentType', () => {
  it.each([
    ['image/png', 'image'],
    ['IMAGE/JPEG; q=1', 'image'],
    ['video/mp4', 'video'],
    ['audio/aac', 'audio'],
    ['application/pdf', 'document'],
    ['', 'document']
  ])('names %s as %s', (contentType, kind) => {
    expect(mediaKindOfContentType(contentType)).toBe(kind)
  })
})

describe('mediaFileProblem', () => {
  const listed = { types: ['image/png'], maxBytes: 100 }
  it('takes a listed type up to the largest size, inclusive', () => {
    expect(mediaFileProblem(listed, 'image/png', 100)).toBeNull()
    expect(mediaFileProblem(listed, 'Image/PNG; x=1', 1)).toBeNull()
  })
  it('names the type first, then an empty size, then a size over the largest', () => {
    expect(mediaFileProblem(listed, 'image/webp', 0)).toBe('type')
    expect(mediaFileProblem(listed, 'image/png', 0)).toBe('empty')
    expect(mediaFileProblem(listed, 'image/png', 101)).toBe('too_large')
  })
  it.each([[Number.NaN], [1.5], [-1], [Number.MAX_SAFE_INTEGER + 1]])(
    'calls %s an empty size',
    size => {
      expect(mediaFileProblem(listed, 'image/png', size)).toBe('empty')
    }
  )
  it('accepts any type when the channel lists none', () => {
    expect(mediaFileProblem({ types: null, maxBytes: 10 }, 'x/y', 10)).toBeNull()
  })
})
