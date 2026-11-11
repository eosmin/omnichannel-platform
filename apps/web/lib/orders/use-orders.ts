'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  useQueryClient,
  type UseMutationResult
} from '@tanstack/react-query'

import {
  type ExportView,
  fetchOrders,
  type OrderListFilter,
  type OrderPageView,
  QueryKeys,
  requestOrdersExport
} from '@platform/api-client'

import { apiClient } from '../api'

// The orders of the store a page at a time (a cursor, TDD_08 §2.4), for the filters and the sort of the address. The rows
// of the earlier filters stay on the screen until the answer for the new ones arrives.
export function useOrderList(
  storeId: string,
  filter: OrderListFilter,
  sort: string,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<OrderPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.orders.list(storeId, filter, sort),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchOrders(apiClient, storeId, { ...filter, sort, cursor: pageParam }, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

// "Export CSV" of the orders page: queues the file for the filters the page shows
export function useExportOrders(
  storeId: string
): UseMutationResult<ExportView, Error, OrderListFilter> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (filter: OrderListFilter) => requestOrdersExport(apiClient, storeId, filter),
    // The exports center shows the new row the moment the person gets there
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.exports.all(storeId) })
    }
  })
}
