import { QueryKeys } from '@platform/api-client'

import { ChannelKeys } from './channel-keys'

describe('the keys of Settings → Channels', () => {
  it('sit under the root of the keys the inbox reads, so one invalidation reaches both', () => {
    const root = ChannelKeys.root('s1')
    expect(QueryKeys.channels.directory('s1').slice(0, root.length)).toEqual(root)
    expect(QueryKeys.channels.templates('s1', 'p', 'c').slice(0, root.length)).toEqual(root)
    expect(ChannelKeys.connections('s1').slice(0, root.length)).toEqual(root)
    expect(ChannelKeys.widget('s1', 'c').slice(0, root.length)).toEqual(root)
  })

  it('keeps one store apart from another', () => {
    expect(ChannelKeys.connections('s1')).not.toEqual(ChannelKeys.connections('s2'))
  })
})
