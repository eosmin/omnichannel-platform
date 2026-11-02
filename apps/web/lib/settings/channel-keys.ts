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
  widget: (storeId: string, connectionId: string): readonly string[] => [
    ...ChannelKeys.root(storeId),
    'widget',
    connectionId
  ],
  plugins: (storeId: string) => ['plugins', storeId, 'available'] as const
}
