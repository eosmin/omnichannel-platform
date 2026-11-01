import { MessageType } from '../status-enums'

import { isOutboundMediaType, mediaMessageTypeOf } from './media-message'

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
