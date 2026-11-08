import { MessageType } from '@platform/core/domain'
import { MediaMessageLimits } from '@platform/core/storage'

import { channelFileLimits } from './channel-file-limits'

const png = { types: ['image/png'], maxBytes: 1000 }
const registryOf = (media: unknown) => ({ mediaOf: () => media }) as never

describe('channelFileLimits', () => {
  const media = {
    maxFilesPerMessage: 10,
    kinds: { image: png, document: { types: null, maxBytes: 5 } }
  }

  it('takes one file while several are off, whatever the channel declares', () => {
    const limits = channelFileLimits(registryOf(media), false)
    expect(limits('whatsapp', MessageType.IMAGE)).toEqual({
      maxFiles: 1,
      ...png,
      captionsPerFile: false
    })
  })

  it('takes what the channel declares once several are on, never more than a request carries', () => {
    expect(
      channelFileLimits(registryOf(media), true)('whatsapp', MessageType.IMAGE)?.maxFiles
    ).toBe(10)
    const huge = { ...media, maxFilesPerMessage: 500 }
    expect(channelFileLimits(registryOf(huge), true)('x', MessageType.IMAGE)?.maxFiles).toBe(
      MediaMessageLimits.MAX_FILES
    )
  })

  it('keeps the rule of the kind: any type when the provider lists none', () => {
    expect(channelFileLimits(registryOf(media), true)('x', MessageType.DOCUMENT)).toEqual({
      maxFiles: 10,
      types: null,
      maxBytes: 5,
      captionsPerFile: false
    })
  })

  it('offers a text under each file only where the switch is on and the channel carries one for the kind', () => {
    const on = channelFileLimits(registryOf(media), true, true)
    const audio = { ...media, kinds: { audio: png } }

    expect(on('instagram', MessageType.IMAGE)?.captionsPerFile).toBe(true)
    // WhatsApp carries no text under an audio file: it is not offered
    expect(
      channelFileLimits(registryOf(audio), true, true)('whatsapp', MessageType.AUDIO)
    ).toMatchObject({
      captionsPerFile: false
    })
  })

  it('has nothing to say for a kind the channel declares no rule for, or a channel with no files', () => {
    expect(channelFileLimits(registryOf(media), true)('x', MessageType.VIDEO)).toBeNull()
    expect(channelFileLimits(registryOf(null), true)('x', MessageType.IMAGE)).toBeNull()
  })
})
