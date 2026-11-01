import { ChannelIds, MessageType } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import { requireCaptionFits } from './caption-rules'

const codeOf = (work: () => void): unknown => {
  try {
    work()
  } catch (error) {
    return error instanceof PlatformException ? error.code : error
  }
  return null
}

describe('requireCaptionFits', () => {
  it('accepts no text, and text within the limit', () => {
    expect(() =>
      requireCaptionFits(ChannelIds.WHATSAPP, MessageType.IMAGE, undefined)
    ).not.toThrow()
    expect(() =>
      requireCaptionFits(ChannelIds.WHATSAPP, MessageType.IMAGE, 'a'.repeat(1024))
    ).not.toThrow()
  })

  it('refuses a WhatsApp caption over 1024 characters, counted as characters', () => {
    expect(() =>
      requireCaptionFits(ChannelIds.WHATSAPP, MessageType.DOCUMENT, 'a'.repeat(1025))
    ).toThrow()
    expect(() =>
      requireCaptionFits(ChannelIds.WHATSAPP, MessageType.IMAGE, '😀'.repeat(1024))
    ).not.toThrow()
  })

  it('refuses text under a WhatsApp audio', () => {
    expect(codeOf(() => requireCaptionFits(ChannelIds.WHATSAPP, MessageType.AUDIO, 'hola'))).toBe(
      ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
    )
  })

  it('holds Instagram and Messenger to the limit of their text', () => {
    expect(() =>
      requireCaptionFits(ChannelIds.INSTAGRAM, MessageType.IMAGE, 'a'.repeat(1001))
    ).toThrow()
    expect(() =>
      requireCaptionFits(ChannelIds.MESSENGER, MessageType.IMAGE, 'a'.repeat(2001))
    ).toThrow()
    expect(() =>
      requireCaptionFits(ChannelIds.MESSENGER, MessageType.AUDIO, 'a'.repeat(2000))
    ).not.toThrow()
  })

  it('does not bound a channel it does not know', () => {
    expect(() => requireCaptionFits('acme', MessageType.IMAGE, 'a'.repeat(5000))).not.toThrow()
  })
})
