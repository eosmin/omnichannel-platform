import { ChannelIconKeys, DEFAULT_CHANNEL_ICON_KEY } from '@platform/core/domain'

import { channelIconOf } from './channel-icon'

describe('channelIconOf', () => {
  it('has an icon for every key a plugin may ask for', () => {
    for (const key of Object.values(ChannelIconKeys)) {
      expect(channelIconOf(key)).toBeDefined()
    }
  })

  it('gives the generic icon to a key outside the closed set, whatever it holds', () => {
    const generic = channelIconOf(DEFAULT_CHANNEL_ICON_KEY)
    for (const key of ['<svg onload=x>', 'constructor', '__proto__', '', 'toString']) {
      expect(channelIconOf(key)).toBe(generic)
    }
    expect(channelIconOf(null)).toBe(generic)
    expect(channelIconOf(undefined)).toBe(generic)
  })
})
