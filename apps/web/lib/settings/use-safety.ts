'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { apiClient } from '../api'

import { IntegrationKeys } from './integration-keys'
import { fetchSafety, saveSafety, type SafetyInput, type SafetyView } from './safety-requests'

// The hooks of Settings → Safety and confirmations, and of the sync that gives the store's choice to every confirmation.
// The settings are read by whoever may see conversations (the api asks `conversations:view`), which the inbox people all hold.

// A minute: the confirmations of a screen left open for hours should follow a change made from another device, and the
// request is small. The save writes its answer here at once.
const STALE_MS = 60_000

export function useSafety(storeId: string, enabled = true): UseQueryResult<SafetyView> {
  return useQuery({
    queryKey: IntegrationKeys.safety(storeId),
    queryFn: ({ signal }) => fetchSafety(apiClient, storeId, signal),
    staleTime: STALE_MS,
    enabled
  })
}

export function useSaveSafety(storeId: string): UseMutationResult<SafetyView, Error, SafetyInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: input => saveSafety(apiClient, storeId, input),
    onSuccess: saved => {
      queryClient.setQueryData(IntegrationKeys.safety(storeId), saved)
    }
  })
}
