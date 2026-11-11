'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type CreateWarehouseInput,
  createWarehouse,
  fetchAllWarehouses,
  QueryKeys,
  replaceWarehouseStores,
  type UpdateWarehouseInput,
  updateWarehouse,
  type WarehouseDetailView,
  type WarehouseStoreLinkInput
} from '@platform/api-client'

import { apiClient } from '../api'

// The hooks of the warehouses screen. Only that page loads this file.

export function useWarehouses(storeId: string): UseQueryResult<WarehouseDetailView[]> {
  return useQuery({
    queryKey: QueryKeys.warehouses.list(storeId),
    queryFn: ({ signal }) => fetchAllWarehouses(apiClient, storeId, signal)
  })
}

function useRefreshWarehouses(): () => void {
  const queryClient = useQueryClient()
  return () => {
    // A warehouse is the organization's: the stores it serves, and the stock screens of each of them, read it too
    void queryClient.invalidateQueries({ queryKey: QueryKeys.warehouses.root })
    void queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.root })
  }
}

export function useCreateWarehouse(
  storeId: string
): UseMutationResult<WarehouseDetailView, Error, CreateWarehouseInput> {
  const refresh = useRefreshWarehouses()
  return useMutation({
    mutationFn: (input: CreateWarehouseInput) => createWarehouse(apiClient, storeId, input),
    onSuccess: refresh
  })
}

export function useUpdateWarehouse(
  storeId: string
): UseMutationResult<WarehouseDetailView, Error, { id: string; input: UpdateWarehouseInput }> {
  const refresh = useRefreshWarehouses()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateWarehouseInput }) =>
      updateWarehouse(apiClient, storeId, id, input),
    onSuccess: refresh
  })
}

export function useReplaceWarehouseStores(
  storeId: string
): UseMutationResult<
  WarehouseDetailView,
  Error,
  { id: string; stores: readonly WarehouseStoreLinkInput[] }
> {
  const refresh = useRefreshWarehouses()
  return useMutation({
    mutationFn: ({ id, stores }: { id: string; stores: readonly WarehouseStoreLinkInput[] }) =>
      replaceWarehouseStores(apiClient, storeId, id, stores),
    onSuccess: refresh
  })
}
