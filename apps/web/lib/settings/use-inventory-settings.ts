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

import {
  fetchInventorySettings,
  type InventorySettingsInput,
  type InventorySettingsView,
  saveInventorySettings
} from './inventory-requests'

// The hooks of Settings → Inventory. Only that page loads this file.

export function useInventorySettings(storeId: string): UseQueryResult<InventorySettingsView> {
  return useQuery({
    queryKey: QueryKeys.inventorySettings.store(storeId),
    queryFn: ({ signal }) => fetchInventorySettings(apiClient, storeId, signal)
  })
}

export function useSaveInventorySettings(
  storeId: string
): UseMutationResult<InventorySettingsView, Error, InventorySettingsInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: InventorySettingsInput) => saveInventorySettings(apiClient, storeId, input),
    onSuccess: view => {
      queryClient.setQueryData(QueryKeys.inventorySettings.store(storeId), view)
    }
  })
}
