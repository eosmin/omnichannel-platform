'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  fetchPluginWidgets,
  fetchPluginWidgetSettings,
  openPluginWidgetSession,
  type PluginWidgetSessionView,
  type PluginWidgetSettingsView,
  type PluginWidgetView,
  QueryKeys,
  setPluginWidgetVisible
} from '@platform/api-client'

import { apiClient } from '../api'

// The widgets a store has, as the inbox sidebar draws them. A minute is enough: a plugin installed or a widget hidden
// shows at the next conversation the agent opens, and the list is small.
const STALE_MS = 60_000

export function usePluginWidgets(
  storeId: string,
  enabled: boolean
): UseQueryResult<PluginWidgetView[]> {
  return useQuery({
    queryKey: QueryKeys.pluginWidgets.list(storeId),
    queryFn: ({ signal }) => fetchPluginWidgets(apiClient, storeId, signal),
    staleTime: STALE_MS,
    enabled
  })
}

// Settings → Plugins: every widget, the hidden ones too
export function usePluginWidgetSettings(
  storeId: string,
  enabled: boolean
): UseQueryResult<PluginWidgetSettingsView[]> {
  return useQuery({
    queryKey: QueryKeys.pluginWidgets.settings(storeId),
    queryFn: ({ signal }) => fetchPluginWidgetSettings(apiClient, storeId, signal),
    staleTime: STALE_MS,
    enabled
  })
}

export interface WidgetVisibilityInput {
  installationId: string
  widgetId: string
  visible: boolean
}

export function useSetPluginWidgetVisible(
  storeId: string
): UseMutationResult<PluginWidgetSettingsView, Error, WidgetVisibilityInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ installationId, widgetId, visible }) =>
      setPluginWidgetVisible(apiClient, storeId, installationId, widgetId, visible),
    onSuccess: () => {
      // The sidebar's list loses or gains the widget: both reads are stale now
      void queryClient.invalidateQueries({ queryKey: QueryKeys.pluginWidgets.list(storeId) })
      void queryClient.invalidateQueries({ queryKey: QueryKeys.pluginWidgets.settings(storeId) })
    }
  })
}

// A session is not cached: each one is a token for one person and one conversation, and the bridge asks for a new
// one before the old one ends
export function openWidgetSession(
  storeId: string,
  installationId: string,
  conversationId: string,
  widgetId: string
): Promise<PluginWidgetSessionView> {
  return openPluginWidgetSession(apiClient, storeId, installationId, conversationId, widgetId)
}
