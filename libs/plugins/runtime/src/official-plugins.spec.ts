import type { Type } from '@nestjs/common'

import { CarrierId, declaredRedactedKeys } from '@platform/core/domain'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import {
  OFFICIAL_CARRIER_PLUGINS,
  OFFICIAL_CHANNEL_PLUGINS,
  officialRedactedKeys,
  redactedKeysOf
} from './official-plugins'

type WithKeys = Type<ChannelPlugin> & { redactedKeys?: unknown }
const plugin = (): WithKeys => class {} as unknown as WithKeys

describe('redactedKeysOf', () => {
  it('joins what each plugin class declares, without repeats', () => {
    const a = Object.assign(plugin(), { redactedKeys: ['acmeSecret', 'both'] })
    const b = Object.assign(plugin(), { redactedKeys: ['both', 'otherKey'] })
    expect(redactedKeysOf([a, b, plugin()])).toEqual(['acmeSecret', 'both', 'otherKey'])
  })

  it('refuses a declaration that is not a list of plain names, so that the boot fails', () => {
    const bad = Object.assign(plugin(), { redactedKeys: ['a.b'] })
    expect(() => redactedKeysOf([bad])).toThrow()
  })
})

describe('officialRedactedKeys', () => {
  it('is what the official plugins declare, every name a plain one', () => {
    const keys = officialRedactedKeys()
    expect(declaredRedactedKeys([...keys])).toEqual(keys)
    expect(keys).toEqual(redactedKeysOf(OFFICIAL_CHANNEL_PLUGINS))
  })

  it('removes the secret of the second app of the Meta channels from the log', () => {
    expect(officialRedactedKeys()).toEqual(
      expect.arrayContaining(['instagramAppSecret', 'instagram_app_secret'])
    )
  })
})

describe('OFFICIAL_CARRIER_PLUGINS', () => {
  it('lists the local courier, whose id the registry knows', () => {
    expect(OFFICIAL_CARRIER_PLUGINS.map(entry => ('id' in entry ? entry.id : null))).toContain(
      CarrierId.LOCAL
    )
  })
})
