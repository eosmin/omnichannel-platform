'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'
import { useCallback } from 'react'

import type { ChannelConnectionListState } from '@platform/core/domain'

import { apiClient } from '../api'
import { usePluginLabel } from '../plugin-label'

import { ChannelKeys } from './channel-keys'
import {
  type ChannelConnectionPageView,
  type ChannelConnectionView,
  type ChannelTestView,
  connectChannel,
  disconnectConnection,
  fetchConnections,
  fetchPluginCatalog,
  fetchWidget,
  installPlugin,
  type PluginCatalogEntryView,
  renameConnection,
  saveWidgetOrigins,
  saveWidgetPreChat,
  testConnection,
  uninstallPlugin,
  updateConnectionToken,
  type WidgetEmbedView
} from './channels-requests'

// The hooks of Settings → Channels and Plugins. Only those two pages load this file.

// A page at a time: the next one is asked by the person. The disconnected ones are asked only when
// `enabled`, so a store that never opens that list never reads it.
export function useConnections(
  storeId: string,
  state: ChannelConnectionListState,
  enabled = true
): UseInfiniteQueryResult<InfiniteData<ChannelConnectionPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: ChannelKeys.connectionList(storeId, state),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchConnections(apiClient, storeId, state, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    enabled
  })
}

export function usePluginCatalog(storeId: string): UseQueryResult<PluginCatalogEntryView[]> {
  const label = usePluginLabel()
  return useQuery({
    queryKey: ChannelKeys.plugins(storeId),
    queryFn: ({ signal }) => fetchPluginCatalog(apiClient, storeId, signal),
    select: useCallback(
      (entries: PluginCatalogEntryView[]) =>
        entries.map(entry => ({ ...entry, name: label(entry.id, entry.name) })),
      [label]
    )
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

export function useRenameConnection(
  storeId: string,
  connectionId: string
): UseMutationResult<ChannelConnectionView, Error, string | null> {
  const refresh = useRefreshChannels(storeId)
  return useMutation({
    mutationFn: (label: string | null) => renameConnection(apiClient, storeId, connectionId, label),
    onSuccess: refresh
  })
}

export function useUpdateToken(
  storeId: string,
  connectionId: string
): UseMutationResult<ChannelConnectionView, Error, Record<string, unknown>> {
  const refresh = useRefreshChannels(storeId)
  return useMutation({
    mutationFn: (credentials: Record<string, unknown>) =>
      updateConnectionToken(apiClient, storeId, connectionId, credentials),
    // The variables hold the secret the person typed: the cache must not keep it once the dialog is closed
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
