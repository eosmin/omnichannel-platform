import { MessageType } from '../status-enums'

import {
  isOutboundMediaType,
  MediaMessageLimits,
  maxFilesFor,
  mediaMessageTypeOf
} from './media-message'

describe('mediaMessageTypeOf', () => {
  it.each([
    ['image/png', MessageType.IMAGE],
    ['video/mp4', MessageType.VIDEO],
    ['audio/ogg', MessageType.AUDIO],
    ['application/pdf', MessageType.DOCUMENT]
  ])('sends %s as %s', (contentType, type) => {
    expect(mediaMessageTypeOf(contentType)).toBe(type)
  })

  it('has no type for a file that cannot be uploaded', () => {
    expect(mediaMessageTypeOf('text/html')).toBeNull()
  })
})

describe('isOutboundMediaType', () => {
  it('accepts the four file types and nothing else', () => {
    expect(isOutboundMediaType(MessageType.IMAGE)).toBe(true)
    expect(isOutboundMediaType(MessageType.TEXT)).toBe(false)
    expect(isOutboundMediaType(MessageType.INTERNAL_NOTE)).toBe(false)
  })
})

describe('maxFilesFor', () => {
  it('is one while several files are off, whatever the channel declares', () => {
    expect(maxFilesFor(10, false)).toBe(1)
    expect(maxFilesFor(1, false)).toBe(1)
  })

  it('is what the channel declares once they are on', () => {
    expect(maxFilesFor(10, true)).toBe(10)
    expect(maxFilesFor(1, true)).toBe(1)
  })

  it('is never less than one nor more than a request carries, even for a value that is not a count', () => {
    for (const odd of [0, -4, Number.NaN, 0.4]) expect(maxFilesFor(odd, true)).toBe(1)
    expect(maxFilesFor(1000, true)).toBe(MediaMessageLimits.MAX_FILES)
    expect(maxFilesFor(Number.POSITIVE_INFINITY, true)).toBe(MediaMessageLimits.MAX_FILES)
  })
})
