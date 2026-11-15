'use client'

import { useStore } from '../../components/providers/store-context'

import { useChannelName } from './use-inbox-data'

// The name the thread gives a plugin: the one its channel declared when it is a channel of the store, else its id (the
// name it has in the registry). An empty id has no name.
export function usePluginName(pluginId: string | null): string {
  const { storeId } = useStore()
  const name = useChannelName(storeId, pluginId ?? '')
  return pluginId === null ? '' : name
}
