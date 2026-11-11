'use client'

import {
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  cancelTransfer,
  closeTransfer,
  type CloseTransferInput,
  createTransfer,
  type CreateTransferInput,
  dispatchTransfer,
  fetchTransfer,
  fetchTransferPage,
  QueryKeys,
  receiveTransfer,
  type ReceiveTransferInput,
  type TransferPageView,
  type TransferView,
  updateTransfer,
  type UpdateTransferInput
} from '@platform/api-client'
import type { TransferStatus } from '@platform/core/domain'

import { apiClient } from '../api'

// The hooks of the transfer screens. Only those pages load this file.

export const ALL_FILTER = 'all'

export function useTransferList(
  storeId: string,
  filters: { status: TransferStatus | typeof ALL_FILTER; warehouseId: string }
): UseInfiniteQueryResult<{ pages: TransferPageView[] }> {
  return useInfiniteQuery({
    queryKey: QueryKeys.transfers.list(storeId, filters.status, filters.warehouseId || ALL_FILTER),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchTransferPage(
        apiClient,
        storeId,
        {
          status: filters.status === ALL_FILTER ? undefined : filters.status,
          warehouseId: filters.warehouseId === '' ? undefined : filters.warehouseId,
          cursor: pageParam
        },
        signal
      ),
    getNextPageParam: page => (page.hasMore ? page.nextCursor : undefined)
  })
}

export function useTransfer(storeId: string, id: string): UseQueryResult<TransferView> {
  return useQuery({
    queryKey: QueryKeys.transfers.byId(storeId, id),
    queryFn: ({ signal }) => fetchTransfer(apiClient, storeId, id, signal)
  })
}

// A transfer moves stock and shows only the lines of the stores of whoever reads it: after any change the transfers
// of every store's cache, and the stock screens, are read again
function useRefreshTransfers(storeId: string): (view: TransferView) => void {
  const queryClient = useQueryClient()
  return view => {
    // What the api answered is what the screen shows at once, before the lists are read again
    queryClient.setQueryData(QueryKeys.transfers.byId(storeId, view.id), view)
    void queryClient.invalidateQueries({ queryKey: QueryKeys.transfers.root })
    void queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.root })
  }
}

export function useCreateTransfer(
  storeId: string
): UseMutationResult<TransferView, Error, CreateTransferInput> {
  const refresh = useRefreshTransfers(storeId)
  return useMutation({
    mutationFn: (input: CreateTransferInput) => createTransfer(apiClient, storeId, input),
    onSuccess: refresh
  })
}

export function useUpdateTransfer(
  storeId: string,
  id: string
): UseMutationResult<TransferView, Error, UpdateTransferInput> {
  const refresh = useRefreshTransfers(storeId)
  return useMutation({
    mutationFn: (input: UpdateTransferInput) => updateTransfer(apiClient, storeId, id, input),
    onSuccess: refresh
  })
}

export function useDispatchTransfer(
  storeId: string,
  id: string
): UseMutationResult<TransferView, Error, void> {
  const refresh = useRefreshTransfers(storeId)
  return useMutation({
    mutationFn: () => dispatchTransfer(apiClient, storeId, id),
    onSuccess: refresh
  })
}

export function useReceiveTransfer(
  storeId: string,
  id: string
): UseMutationResult<TransferView, Error, ReceiveTransferInput> {
  const refresh = useRefreshTransfers(storeId)
  return useMutation({
    mutationFn: (input: ReceiveTransferInput) => receiveTransfer(apiClient, storeId, id, input),
    onSuccess: refresh
  })
}

export function useCloseTransfer(
  storeId: string,
  id: string
): UseMutationResult<TransferView, Error, CloseTransferInput> {
  const refresh = useRefreshTransfers(storeId)
  return useMutation({
    mutationFn: (input: CloseTransferInput) => closeTransfer(apiClient, storeId, id, input),
    onSuccess: refresh
  })
}

export function useCancelTransfer(
  storeId: string,
  id: string
): UseMutationResult<TransferView, Error, void> {
  const refresh = useRefreshTransfers(storeId)
  return useMutation({
    mutationFn: () => cancelTransfer(apiClient, storeId, id),
    onSuccess: refresh
  })
}
