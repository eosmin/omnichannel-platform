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
  fetchReturnSettings,
  type ReturnSettingsInput,
  type ReturnSettingsView,
  saveReturnSettings
} from './return-settings-requests'

// The hooks of Settings → Returns. Only that page loads this file.

export function useReturnSettings(storeId: string): UseQueryResult<ReturnSettingsView> {
  return useQuery({
    queryKey: QueryKeys.returnSettings.store(storeId),
    queryFn: ({ signal }) => fetchReturnSettings(apiClient, storeId, signal)
  })
}

export function useSaveReturnSettings(
  storeId: string
): UseMutationResult<ReturnSettingsView, Error, ReturnSettingsInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReturnSettingsInput) => saveReturnSettings(apiClient, storeId, input),
    onSuccess: view => {
      queryClient.setQueryData(QueryKeys.returnSettings.store(storeId), view)
    }
  })
}
