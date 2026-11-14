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

import {
  type CarrierConnectionView,
  type CarrierRegistryEntryView,
  type CarrierStatusCatalogEntryView,
  type CarrierTestResultView,
  type ConnectCarrierInput,
  type ConnectedCarrierView,
  connectCarrier,
  disconnectCarrier,
  fetchAllCarrierConnections,
  fetchCarrierStatusCatalog,
  fetchCarrierRegistry,
  fetchStatusMappings,
  fetchUnmappedStatuses,
  putStatusMapping,
  QueryKeys,
  removeStatusMapping,
  rotateCarrierWebhookSecret,
  type StatusMappingPageView,
  type StatusMappingView,
  testCarrier,
  type UnmappedStatusPageView,
  updateCarrier,
  type UpdateCarrierInput
} from '@platform/api-client'

import { apiClient } from '../api'

// The hooks of Settings → Carriers. Only that page loads this file. Every write makes the store's carrier caches stale,
// so the list, the mappings and the waiting codes are read again.

export function useCarrierRegistry(storeId: string): UseQueryResult<CarrierRegistryEntryView[]> {
  return useQuery({
    queryKey: QueryKeys.carriers.registry(storeId),
    queryFn: ({ signal }) => fetchCarrierRegistry(apiClient, storeId, signal)
  })
}

export function useCarrierConnections(storeId: string): UseQueryResult<CarrierConnectionView[]> {
  return useQuery({
    queryKey: QueryKeys.carriers.list(storeId),
    queryFn: ({ signal }) => fetchAllCarrierConnections(apiClient, storeId, signal)
  })
}

// Not awaited: a slow list read must never hold back the answer of a write, which may carry a secret shown once
function useRefresh(storeId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: QueryKeys.carriers.all(storeId) })
  }
}

export function useConnectCarrier(
  storeId: string
): UseMutationResult<ConnectedCarrierView, Error, ConnectCarrierInput> {
  const refresh = useRefresh(storeId)
  return useMutation({
    mutationFn: (input: ConnectCarrierInput) => connectCarrier(apiClient, storeId, input),
    // The answer holds the secret of the webhook once: the cache must not keep a copy
    gcTime: 0,
    onSuccess: refresh
  })
}

export function useUpdateCarrier(
  storeId: string,
  connectionId: string
): UseMutationResult<CarrierConnectionView, Error, UpdateCarrierInput> {
  const refresh = useRefresh(storeId)
  return useMutation({
    mutationFn: (input: UpdateCarrierInput) =>
      updateCarrier(apiClient, storeId, connectionId, input),
    onSuccess: refresh
  })
}

// A test writes the health of the connection (and may leave it in `error`), so the list is read again after it
export function useTestCarrier(
  storeId: string,
  connectionId: string
): UseMutationResult<CarrierTestResultView, Error, void> {
  const refresh = useRefresh(storeId)
  return useMutation({
    mutationFn: () => testCarrier(apiClient, storeId, connectionId),
    onSettled: refresh
  })
}

export function useRotateWebhookSecret(
  storeId: string,
  connectionId: string
): UseMutationResult<{ webhookSecret: string }, Error, void> {
  const refresh = useRefresh(storeId)
  return useMutation({
    mutationFn: () => rotateCarrierWebhookSecret(apiClient, storeId, connectionId),
    // The answer holds the new secret once: the cache must not keep a copy
    gcTime: 0,
    onSuccess: refresh
  })
}

export function useDisconnectCarrier(
  storeId: string
): UseMutationResult<CarrierConnectionView, Error, string> {
  const refresh = useRefresh(storeId)
  return useMutation({
    mutationFn: (connectionId: string) => disconnectCarrier(apiClient, storeId, connectionId),
    onSuccess: refresh
  })
}

type MappingPages = InfiniteData<StatusMappingPageView, string | null>
type UnmappedPages = InfiniteData<UnmappedStatusPageView, string | null>

export function useStatusMappings(
  storeId: string,
  connectionId: string
): UseInfiniteQueryResult<MappingPages> {
  return useInfiniteQuery({
    queryKey: QueryKeys.carriers.statusMappings(storeId, connectionId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchStatusMappings(apiClient, storeId, connectionId, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined)
  })
}

export function useUnmappedStatuses(
  storeId: string,
  connectionId: string
): UseInfiniteQueryResult<UnmappedPages> {
  return useInfiniteQuery({
    queryKey: QueryKeys.carriers.unmappedStatuses(storeId, connectionId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchUnmappedStatuses(apiClient, storeId, connectionId, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined)
  })
}

// Every code the plugin knows with the row the connection holds for it: the table offers the ones with no row yet
export function useStatusCatalog(
  storeId: string,
  connectionId: string
): UseQueryResult<CarrierStatusCatalogEntryView[]> {
  return useQuery({
    queryKey: QueryKeys.carriers.statusCatalog(storeId, connectionId),
    queryFn: ({ signal }) => fetchCarrierStatusCatalog(apiClient, storeId, connectionId, signal)
  })
}

export interface MappingChange {
  providerCode: string
  // null ignores the code on purpose
  status: string | null
}

export function usePutStatusMapping(
  storeId: string,
  connectionId: string
): UseMutationResult<StatusMappingView, Error, MappingChange> {
  const refresh = useRefresh(storeId)
  return useMutation({
    mutationFn: (change: MappingChange) =>
      putStatusMapping(apiClient, storeId, connectionId, change.providerCode, change.status),
    onSuccess: refresh
  })
}

export function useRemoveStatusMapping(
  storeId: string,
  connectionId: string
): UseMutationResult<void, Error, string> {
  const refresh = useRefresh(storeId)
  return useMutation({
    mutationFn: (providerCode: string) =>
      removeStatusMapping(apiClient, storeId, connectionId, providerCode),
    onSuccess: refresh
  })
}
