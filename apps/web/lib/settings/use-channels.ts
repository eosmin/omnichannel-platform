'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { apiClient } from '../api'

import { ChannelKeys } from './channel-keys'
import {
  type ChannelConnectionView,
  type ChannelTestView,
  connectChannel,
  disconnectConnection,
  fetchConnections,
  fetchPluginCatalog,
  fetchWidget,
  installPlugin,
  type PluginCatalogEntryView,
  saveWidgetOrigins,
  saveWidgetPreChat,
  testConnection,
  uninstallPlugin,
  type WidgetEmbedView
} from './channels-requests'

// The hooks of Settings → Channels and Plugins. Only those two pages load this file.

export function useConnections(storeId: string): UseQueryResult<ChannelConnectionView[]> {
  return useQuery({
    queryKey: ChannelKeys.connections(storeId),
    queryFn: ({ signal }) => fetchConnections(apiClient, storeId, signal)
  })
}

export function usePluginCatalog(storeId: string): UseQueryResult<PluginCatalogEntryView[]> {
  return useQuery({
    queryKey: ChannelKeys.plugins(storeId),
    queryFn: ({ signal }) => fetchPluginCatalog(apiClient, storeId, signal)
  })
}

// A connection that is made or unmade changes the list, the catalog (how many are active), and the
// directory the inbox names its channels from
function useRefreshChannels(storeId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ChannelKeys.root(storeId) })
    void queryClient.invalidateQueries({ queryKey: ChannelKeys.plugins(storeId) })
  }
}

export function useConnect(
  storeId: string,
  pluginId: string
): UseMutationResult<ChannelConnectionView, Error, Record<string, unknown>> {
  const refresh = useRefreshChannels(storeId)
  return useMutation({
    mutationFn: (credentials: Record<string, unknown>) =>
      connectChannel(apiClient, storeId, pluginId, credentials),
    // The variables hold the secrets the person typed: the cache must not keep them once the dialog is closed
    gcTime: 0,
    onSuccess: refresh
  })
}

// The verdict is stored on the connection, so the list is read again whatever it was
export function useTestConnection(
  storeId: string,
  connectionId: string
): UseMutationResult<ChannelTestView, Error, void> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => testConnection(apiClient, storeId, connectionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ChannelKeys.connections(storeId) })
  })
}

export function useDisconnect(
  storeId: string
): UseMutationResult<ChannelConnectionView, Error, string> {
  const refresh = useRefreshChannels(storeId)
  return useMutation({
    mutationFn: (connectionId: string) => disconnectConnection(apiClient, storeId, connectionId),
    // Also on failure: a connection another tab already disconnected must leave the active ones
    onSettled: refresh
  })
}

export function useWidget(storeId: string, connectionId: string): UseQueryResult<WidgetEmbedView> {
  return useQuery({
    queryKey: ChannelKeys.widget(storeId, connectionId),
    queryFn: ({ signal }) => fetchWidget(apiClient, storeId, connectionId, signal)
  })
}

// Both widget changes answer with the whole widget, which replaces what the page has
export function useSaveWidgetOrigins(
  storeId: string,
  connectionId: string
): UseMutationResult<WidgetEmbedView, Error, string[]> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (siteOrigins: string[]) =>
      saveWidgetOrigins(apiClient, storeId, connectionId, siteOrigins),
    onSuccess: saved => queryClient.setQueryData(ChannelKeys.widget(storeId, connectionId), saved)
  })
}

export function useSaveWidgetPreChat(
  storeId: string,
  connectionId: string
): UseMutationResult<WidgetEmbedView, Error, boolean> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) => saveWidgetPreChat(apiClient, storeId, connectionId, enabled),
    onSuccess: saved => queryClient.setQueryData(ChannelKeys.widget(storeId, connectionId), saved)
  })
}

export function useInstallPlugin(
  storeId: string
): UseMutationResult<PluginCatalogEntryView, Error, string> {
  const refresh = useRefreshChannels(storeId)
  return useMutation({
    mutationFn: (pluginId: string) => installPlugin(apiClient, storeId, pluginId),
    onSuccess: refresh
  })
}

// Uninstalling disconnects what hangs from the plugin, so the connections are read again too. Also on
// failure: the run that failed half way is finished by running it again, and the list must show where it is.
export function useUninstallPlugin(
  storeId: string
): UseMutationResult<PluginCatalogEntryView, Error, string> {
  const refresh = useRefreshChannels(storeId)
  return useMutation({
    mutationFn: (installationId: string) => uninstallPlugin(apiClient, storeId, installationId),
    onSettled: refresh
  })
}
