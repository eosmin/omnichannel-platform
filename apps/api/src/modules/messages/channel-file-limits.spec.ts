import { ChannelCapability, MessageType } from '@platform/core/domain'
import { MediaMessageLimits } from '@platform/core/storage'

import { channelFileLimits } from './channel-file-limits'

const png = { types: ['image/png'], maxBytes: 1000 }
// The capabilities a channel declared when it registered, by channel type
const registryOf = (media: unknown, capabilities: Record<string, string[]> = {}) =>
  ({ mediaOf: () => media, capabilitiesOf: (type: string) => capabilities[type] ?? [] }) as never

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
      captionsPerFile: false,
      textAfterFile: false
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
      captionsPerFile: false,
      textAfterFile: false
    })
  })

  it('offers a text under each file only to a channel that declares it, for every kind (an audio goes apart)', () => {
    const audio = { ...media, kinds: { audio: png } }
    const registry = registryOf(media, { whatsapp: [ChannelCapability.CAPTION_PER_FILE] })
    const audioRegistry = registryOf(audio, { whatsapp: [ChannelCapability.CAPTION_PER_FILE] })

    expect(channelFileLimits(registry, true)('whatsapp', MessageType.IMAGE)?.captionsPerFile).toBe(
      true
    )
    // An audio on WhatsApp has no place for a text: none under a file but the first, and the text of the
    // message goes after the first one
    expect(channelFileLimits(audioRegistry, true)('whatsapp', MessageType.AUDIO)).toMatchObject({
      captionsPerFile: false,
      textAfterFile: true
    })
    // Another channel of the same registry (it sends the text as a message of its own) does not
    expect(channelFileLimits(registry, true)('instagram', MessageType.IMAGE)?.captionsPerFile).toBe(
      false
    )
    expect(channelFileLimits(registryOf(media), true)('whatsapp', MessageType.IMAGE)).toMatchObject(
      { captionsPerFile: false, textAfterFile: false }
    )
  })

  it('has nothing to say for a kind the channel declares no rule for, or a channel with no files', () => {
    expect(channelFileLimits(registryOf(media), true)('x', MessageType.VIDEO)).toBeNull()
    expect(channelFileLimits(registryOf(null), true)('x', MessageType.IMAGE)).toBeNull()
  })
})
