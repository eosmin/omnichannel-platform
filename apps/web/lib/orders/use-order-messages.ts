'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  fetchOrderMessages,
  fetchOrderTemplates,
  type OrderMessagePreviewView,
  type OrderTemplateView,
  type OrderMessageHistoryPageView,
  type OrderMessageOutcomeView,
  previewOrderMessage,
  QueryKeys,
  sendOrderMessage
} from '@platform/api-client'

import { apiClient } from '../api'

// What the Messages panel reads and writes. The history is one page at a time, newest first, and follows the cursor of the last page.
export function useOrderMessageHistory(
  storeId: string,
  orderId: string
): UseInfiniteQueryResult<InfiniteData<OrderMessageHistoryPageView, string | undefined>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.orders.messages(storeId, orderId),
    queryFn: ({ pageParam, signal }): Promise<OrderMessageHistoryPageView> =>
      fetchOrderMessages(apiClient, storeId, orderId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => (page.hasMore ? (page.nextCursor ?? undefined) : undefined)
  })
}

// The templates of the store, for the "Notify the customer" box of a status change: whether the template of its kind goes by itself.
// Reading them asks for orders:view, which the page already needs.
export function useOrderTemplatesForNotify(
  storeId: string,
  enabled: boolean
): UseQueryResult<OrderTemplateView[]> {
  return useQuery({
    queryKey: QueryKeys.orderTemplates.all(storeId),
    queryFn: ({ signal }) => fetchOrderTemplates(apiClient, storeId, signal),
    enabled
  })
}

export interface OrderMessageWrites {
  preview: UseMutationResult<OrderMessagePreviewView, Error, string>
  // One press is one key: the same press sent twice sends once, a new press sends again
  send: UseMutationResult<OrderMessageOutcomeView, Error, { kind: string; idempotencyKey: string }>
}

export function useOrderMessageWrites(storeId: string, orderId: string): OrderMessageWrites {
  const queryClient = useQueryClient()
  return {
    preview: useMutation({
      mutationFn: (kind: string) => previewOrderMessage(apiClient, storeId, orderId, kind)
    }),
    send: useMutation({
      mutationFn: (input: { kind: string; idempotencyKey: string }) =>
        sendOrderMessage(apiClient, storeId, orderId, input),
      // Whatever the answer (sent, not sent with its reason, the key had been used) the history has a new row
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: QueryKeys.orders.messages(storeId, orderId) })
    })
  }
}
