import { ChannelMediaKinds, frozenMedia } from './channel-media-rules'

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
