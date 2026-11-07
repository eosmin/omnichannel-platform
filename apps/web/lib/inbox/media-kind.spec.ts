import { MessageType } from '@platform/core/domain'

import { mediaKindOf } from './media-kind'

describe('mediaKindOf', () => {
  it('draws a voice note that is an mp4 with the audio player, not as a video', () => {
    expect(mediaKindOf(MessageType.AUDIO, 'video/mp4')).toBe(MessageType.AUDIO)
    expect(mediaKindOf(MessageType.AUDIO, 'video/quicktime')).toBe(MessageType.AUDIO)
  })

  it.each([
    [MessageType.AUDIO, 'audio/mp4', MessageType.AUDIO],
    [MessageType.AUDIO, 'audio/ogg', MessageType.AUDIO],
    [MessageType.VIDEO, 'video/mp4', MessageType.VIDEO],
    [MessageType.IMAGE, 'image/png', MessageType.IMAGE],
    [MessageType.DOCUMENT, 'application/pdf', MessageType.DOCUMENT],
    // A file is drawn as what it is, whatever the message started with
    [MessageType.IMAGE, 'video/mp4', MessageType.VIDEO],
    [MessageType.DOCUMENT, 'video/mp4', MessageType.VIDEO],
    [MessageType.TEXT, 'video/mp4', MessageType.VIDEO],
    [MessageType.AUDIO, 'image/png', MessageType.IMAGE],
    [MessageType.AUDIO, 'application/pdf', 'DOCUMENT']
  ])('draws a %s message file of %s as %s', (messageType, contentType, kind) => {
    expect(mediaKindOf(messageType, contentType)).toBe(kind)
  })

  it('has no kind for a type the platform does not keep', () => {
    expect(mediaKindOf(MessageType.AUDIO, 'application/x-msdownload')).toBeNull()
    expect(mediaKindOf(MessageType.VIDEO, '')).toBeNull()
  })
})
