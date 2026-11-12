'use client'

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  approveReturn,
  cancelReturn,
  completeReturn,
  createReturn,
  createReturnShipment,
  fetchReturns,
  markReturnInTransit,
  QueryKeys,
  receiveReturn,
  rejectReturn,
  type ReturnShipmentView,
  type ReturnView
} from '@platform/api-client'
import type {
  ApproveReturnBody,
  CompleteReturnBody,
  CreateReturnBody,
  CreateReturnShipmentBody,
  ReceiveReturnBody,
  ReturnDecisionBody
} from '@platform/core/domain'

import { apiClient } from '../api'

// The most returns one order can show: an order has few, and the api pages at this size
const ORDER_RETURNS_LIMIT = 100

// The returns of one order, newest first (the panel of the order detail). Reading them asks for returns:view.
export function useOrderReturns(
  storeId: string,
  orderId: string,
  enabled: boolean
): UseQueryResult<ReturnView[]> {
  return useQuery({
    queryKey: QueryKeys.returns.ofOrder(storeId, orderId),
    queryFn: async ({ signal }) =>
      (await fetchReturns(apiClient, storeId, { orderId, limit: ORDER_RETURNS_LIMIT }, signal))
        .data,
    enabled
  })
}

export interface ReturnWrites {
  create: UseMutationResult<ReturnView, Error, CreateReturnBody>
  approve: UseMutationResult<ReturnView, Error, { returnId: string; body: ApproveReturnBody }>
  reject: UseMutationResult<ReturnView, Error, { returnId: string; body: ReturnDecisionBody }>
  cancel: UseMutationResult<ReturnView, Error, { returnId: string; body: ReturnDecisionBody }>
  inTransit: UseMutationResult<ReturnView, Error, string>
  receive: UseMutationResult<ReturnView, Error, { returnId: string; body: ReceiveReturnBody }>
  complete: UseMutationResult<ReturnView, Error, { returnId: string; body: CompleteReturnBody }>
  // The guide of the way back: it makes a guide, so the guides of the order are read again too
  returnGuide: UseMutationResult<
    ReturnShipmentView,
    Error,
    { returnId: string; body: CreateReturnShipmentBody }
  >
}

// A return changes what its order shows (the stock, the status of an order that came back whole, a replacement order born of an
// exchange) and what the lists show: every one marks the returns of the order, the order itself and the lists as stale. A move that
// is refused leaves the screen as it was.
export function useReturnWrites(storeId: string, orderId: string): ReturnWrites {
  const queryClient = useQueryClient()
  const refresh = async (): Promise<void> => {
    await Promise.all([
      // The returns of the order, the lists and the details of the returns screens are all under `returns`
      queryClient.invalidateQueries({ queryKey: QueryKeys.returns.all(storeId) }),
      queryClient.invalidateQueries({ queryKey: QueryKeys.shipments.all(storeId) }),
      queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.all(storeId) }),
      queryClient.invalidateQueries({ queryKey: QueryKeys.orders.byId(storeId, orderId) }),
      queryClient.invalidateQueries({ queryKey: [...QueryKeys.orders.all(storeId), 'list'] })
    ])
  }
  return {
    create: useMutation({
      mutationFn: (body: CreateReturnBody) => createReturn(apiClient, storeId, body),
      onSuccess: refresh
    }),
    approve: useMutation({
      mutationFn: ({ returnId, body }) => approveReturn(apiClient, storeId, returnId, body),
      onSuccess: refresh
    }),
    reject: useMutation({
      mutationFn: ({ returnId, body }) => rejectReturn(apiClient, storeId, returnId, body),
      onSuccess: refresh
    }),
    cancel: useMutation({
      mutationFn: ({ returnId, body }) => cancelReturn(apiClient, storeId, returnId, body),
      onSuccess: refresh
    }),
    inTransit: useMutation({
      mutationFn: (returnId: string) => markReturnInTransit(apiClient, storeId, returnId),
      onSuccess: refresh
    }),
    receive: useMutation({
      mutationFn: ({ returnId, body }) => receiveReturn(apiClient, storeId, returnId, body),
      onSuccess: refresh
    }),
    complete: useMutation({
      mutationFn: ({ returnId, body }) => completeReturn(apiClient, storeId, returnId, body),
      onSuccess: refresh
    }),
    returnGuide: useMutation({
      mutationFn: ({ returnId, body }) => createReturnShipment(apiClient, storeId, returnId, body),
      onSuccess: refresh
    })
  }
}
