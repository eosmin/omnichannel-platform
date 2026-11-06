// The query keys of Settings → Channels and Plugins, kept with the pages that read them: the
// `QueryKeys` module is loaded by the inbox, which has no use for these. They sit under the
// `['channels', storeId]` root of `QueryKeys.channels`, so one invalidation of the root reaches the
// directory the inbox names its channels from.
import { QueryKeys } from '@platform/api-client'

export const ChannelKeys = {
  root: (storeId: string): readonly string[] => QueryKeys.channels.directory(storeId).slice(0, 2),
  connections: (storeId: string): readonly string[] => [
    ...ChannelKeys.root(storeId),
    'connections'
  ],
  // One list per state, under `connections`: the invalidation of that key reaches both
  connectionList: (storeId: string, state: string): readonly string[] => [
    ...ChannelKeys.connections(storeId),
    state
  ],
  widget: (storeId: string, connectionId: string): readonly string[] => [
    ...ChannelKeys.root(storeId),
    'widget',
    connectionId
  ],
  plugins: (storeId: string) => ['plugins', storeId, 'available'] as const,
  // The Pages of a login with Facebook. Outside the channels root on purpose: refreshing the channels must not
  // list them again, nor ask for a session that was just used.
  loginAssets: (storeId: string, sessionId: string) =>
    ['channel-login', storeId, 'assets', sessionId] as const
}
