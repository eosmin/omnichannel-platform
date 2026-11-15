'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

import { ChannelKeys } from './channel-keys'
import {
  fetchPluginConsent,
  fetchPluginDetail,
  installIntegrationPlugin,
  type PluginConsentView,
  type PluginDetailView,
  type PluginInstallResultView,
  reissueSetupCode,
  type PluginSetupOfferView,
  registerPlugin,
  type RegisteredPluginView,
  rotateCommandSecret,
  type RotatedCommandSecretView
} from './plugins-requests'

// The hooks of Settings → Plugins (Step 5.6 PR W1). Only that page loads this file.

// A plugin that is registered, installed or revoked changes the catalog, the detail and the widgets it draws
function useRefreshPlugins(storeId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ChannelKeys.pluginsRoot(storeId) })
    void queryClient.invalidateQueries({ queryKey: QueryKeys.pluginWidgets.list(storeId) })
    void queryClient.invalidateQueries({ queryKey: QueryKeys.pluginWidgets.settings(storeId) })
  }
}

// What installing the plugin would grant. Never cached for long: a manifest that changed after the screen was read is refused by
// the api at install, and the owner must read what is asked now.
export function usePluginConsent(
  storeId: string,
  pluginId: string
): UseQueryResult<PluginConsentView> {
  return useQuery({
    queryKey: ChannelKeys.pluginConsent(storeId, pluginId),
    queryFn: ({ signal }) => fetchPluginConsent(apiClient, storeId, pluginId, signal),
    gcTime: 0,
    staleTime: 0
  })
}

export function usePluginDetail(
  storeId: string,
  pluginId: string
): UseQueryResult<PluginDetailView> {
  return useQuery({
    queryKey: ChannelKeys.pluginDetail(storeId, pluginId),
    queryFn: ({ signal }) => fetchPluginDetail(apiClient, storeId, pluginId, signal)
  })
}

export function useRegisterPlugin(
  storeId: string
): UseMutationResult<RegisteredPluginView, Error, unknown> {
  const refresh = useRefreshPlugins(storeId)
  return useMutation({
    mutationFn: (manifest: unknown) => registerPlugin(apiClient, storeId, manifest),
    onSuccess: refresh
  })
}

// The answer carries the one-time setup code: the cache does not keep it once the dialog is closed
export function useInstallIntegrationPlugin(
  storeId: string,
  pluginId: string
): UseMutationResult<PluginInstallResultView, Error, readonly string[]> {
  const refresh = useRefreshPlugins(storeId)
  return useMutation({
    mutationFn: (scopes: readonly string[]) =>
      installIntegrationPlugin(apiClient, storeId, pluginId, scopes),
    gcTime: 0,
    onSuccess: refresh
  })
}

export function useReissueSetupCode(
  storeId: string
): UseMutationResult<PluginSetupOfferView, Error, string> {
  return useMutation({
    mutationFn: (installationId: string) => reissueSetupCode(apiClient, storeId, installationId),
    gcTime: 0
  })
}

export function useRotateCommandSecret(
  storeId: string
): UseMutationResult<RotatedCommandSecretView, Error, string> {
  return useMutation({
    mutationFn: (installationId: string) => rotateCommandSecret(apiClient, storeId, installationId),
    gcTime: 0
  })
}
