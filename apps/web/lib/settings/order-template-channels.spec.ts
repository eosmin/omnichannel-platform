import type { ChannelDirectoryEntryView } from '@platform/api-client'
import { ChannelCapability } from '@platform/core/domain'

import { linkableChannels } from './order-template-channels'

const entry = (patch: Partial<ChannelDirectoryEntryView>): ChannelDirectoryEntryView => ({
  id: 'c1',
  pluginId: 'p1',
  pluginName: 'Plugin one',
  displayName: 'Account one',
  status: 'active',
  capabilities: [
    ChannelCapability.TEXT,
    ChannelCapability.TEMPLATES,
    ChannelCapability.MESSAGING_WINDOW
  ],
  ...patch
})

describe('linkableChannels', () => {
  it('offers a plugin that declares templates and a messaging window, with its working accounts', () => {
    expect(linkableChannels([entry({}), entry({ id: 'c2', displayName: 'Account two' })])).toEqual([
      {
        pluginId: 'p1',
        pluginName: 'Plugin one',
        connections: [
          { id: 'c1', displayName: 'Account one' },
          { id: 'c2', displayName: 'Account two' }
        ]
      }
    ])
  })

  it('does not offer a plugin that lacks either capability', () => {
    expect(
      linkableChannels([
        entry({ capabilities: [ChannelCapability.TEXT, ChannelCapability.TEMPLATES] }),
        entry({
          pluginId: 'p2',
          capabilities: [ChannelCapability.TEXT, ChannelCapability.MESSAGING_WINDOW]
        }),
        entry({ pluginId: 'p3', capabilities: [ChannelCapability.TEXT] })
      ])
    ).toEqual([])
  })

  it('keeps a plugin whose accounts are all down, with no account to read templates from', () => {
    expect(
      linkableChannels([entry({ status: 'error' }), entry({ id: 'c2', status: 'disconnected' })])
    ).toEqual([{ pluginId: 'p1', pluginName: 'Plugin one', connections: [] }])
  })

  it('is empty for a store with no channel', () => {
    expect(linkableChannels([])).toEqual([])
  })
})
