'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  cancelPurchaseOrder,
  type ClosePurchaseOrderInput,
  closePurchaseOrder,
  type CreatePurchaseOrderInput,
  type CreateSupplierInput,
  createPurchaseOrder,
  createSupplier,
  fetchAllSuppliers,
  fetchPayables,
  fetchPurchaseOrder,
  fetchPurchaseOrderPage,
  fetchPurchaseOrderPayments,
  fetchSupplier,
  fetchSupplierBalance,
  fetchSupplierPage,
  fetchSupplierPaymentReturns,
  fetchSupplierPayments,
  orderPurchaseOrder,
  type PayablesView,
  type PurchaseOrderPageView,
  type PurchaseOrderView,
  QueryKeys,
  type ReceivePurchaseOrderInput,
  type RecordPaymentReturnInput,
  type RecordSupplierPaymentInput,
  receivePurchaseOrder,
  recordPurchaseOrderPayment,
  recordSupplierPayment,
  recordSupplierPaymentReturn,
  type SupplierBalanceView,
  type SupplierPageView,
  type SupplierPaymentPageView,
  type SupplierPaymentReturnPageView,
  type SupplierPaymentReturnView,
  type SupplierPaymentView,
  type SupplierView,
  type UpdatePurchaseOrderInput,
  type UpdateSupplierInput,
  updatePurchaseOrder,
  updateSupplier,
  type VoidPaymentReturnInput,
  type VoidSupplierPaymentInput,
  voidSupplierPayment,
  voidSupplierPaymentReturn
} from '@platform/api-client'
import type { PurchaseOrderStatus } from '@platform/core/domain'

import { apiClient } from '../api'

// The hooks of the purchase screens (Step 4B.9a-4). A purchase writes entries and moves stock, so every write makes the whole
// `finance` root stale (the suppliers, the orders, the payables, the balances) and the stock of the store.

const filterKey = (filters: Record<string, string | boolean | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(filters).flatMap(([key, value]) =>
      value === undefined || value === '' || value === false ? [] : [[key, String(value)]]
    )
  )

export function useSupplierPages(
  storeId: string,
  filters: { q: string; includeInactive: boolean },
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<SupplierPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.purchases.suppliers(storeId, filterKey(filters)),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchSupplierPage(apiClient, storeId, { ...filters, cursor: pageParam }, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

// Every supplier, for a select: the ones switched off are left to the caller to hide
export function useAllSuppliers(storeId: string, enabled: boolean): UseQueryResult<SupplierView[]> {
  return useQuery({
    queryKey: QueryKeys.purchases.allSuppliers(storeId),
    queryFn: ({ signal }) => fetchAllSuppliers(apiClient, storeId, signal),
    enabled
  })
}

export function useSupplier(storeId: string, id: string | null): UseQueryResult<SupplierView> {
  return useQuery({
    queryKey: QueryKeys.purchases.supplier(storeId, id ?? ''),
    queryFn: ({ signal }) => fetchSupplier(apiClient, storeId, id ?? '', signal),
    enabled: id !== null
  })
}

export function useSupplierBalance(
  storeId: string,
  id: string | null
): UseQueryResult<SupplierBalanceView> {
  return useQuery({
    queryKey: QueryKeys.purchases.supplierBalance(storeId, id ?? ''),
    queryFn: ({ signal }) => fetchSupplierBalance(apiClient, storeId, id ?? '', signal),
    enabled: id !== null
  })
}

export function useSupplierPayments(
  storeId: string,
  id: string | null
): UseInfiniteQueryResult<InfiniteData<SupplierPaymentPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.purchases.supplierPayments(storeId, id ?? ''),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchSupplierPayments(apiClient, storeId, id ?? '', pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    enabled: id !== null
  })
}

export function usePayables(
  storeId: string,
  filters: { supplierId: string; overdueOnly: boolean },
  enabled: boolean
): UseQueryResult<PayablesView> {
  return useQuery({
    queryKey: QueryKeys.purchases.payables(storeId, filterKey(filters)),
    queryFn: ({ signal }) => fetchPayables(apiClient, storeId, filters, signal),
    placeholderData: keepPreviousData,
    enabled
  })
}

export function usePurchaseOrderPages(
  storeId: string,
  filters: { status: PurchaseOrderStatus | ''; supplierId: string },
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<PurchaseOrderPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.purchases.orders(storeId, filterKey(filters)),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchPurchaseOrderPage(
        apiClient,
        storeId,
        {
          cursor: pageParam,
          supplierId: filters.supplierId,
          ...(filters.status === '' ? {} : { status: filters.status })
        },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

export function usePurchaseOrder(
  storeId: string,
  id: string,
  enabled: boolean
): UseQueryResult<PurchaseOrderView> {
  return useQuery({
    queryKey: QueryKeys.purchases.order(storeId, id),
    queryFn: ({ signal }) => fetchPurchaseOrder(apiClient, storeId, id, signal),
    enabled
  })
}

export function usePurchaseOrderPayments(
  storeId: string,
  id: string,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<SupplierPaymentPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.purchases.orderPayments(storeId, id),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchPurchaseOrderPayments(apiClient, storeId, id, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    enabled
  })
}

type Write<TInput, TResult> = UseMutationResult<TResult, Error, TInput>

function usePurchaseWrite<TInput, TResult>(
  storeId: string,
  write: (input: TInput) => Promise<TResult>
): Write<TInput, TResult> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: write,
    onSuccess: async () => {
      // A receipt moves stock: the counts of the store read again too
      void queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.all(storeId) })
      // Returned, so the mutation settles after the lists have been read again: a dialog closes on fresh data, not on the old
      await queryClient.invalidateQueries({ queryKey: QueryKeys.finance.root })
    }
  })
}

export const useCreateSupplier = (storeId: string): Write<CreateSupplierInput, SupplierView> =>
  usePurchaseWrite(storeId, input => createSupplier(apiClient, storeId, input))

export const useUpdateSupplier = (
  storeId: string
): Write<{ id: string; changes: UpdateSupplierInput }, SupplierView> =>
  usePurchaseWrite(storeId, input => updateSupplier(apiClient, storeId, input.id, input.changes))

export const useCreatePurchaseOrder = (
  storeId: string
): Write<CreatePurchaseOrderInput, PurchaseOrderView> =>
  usePurchaseWrite(storeId, input => createPurchaseOrder(apiClient, storeId, input))

export const useUpdatePurchaseOrder = (
  storeId: string
): Write<{ id: string; changes: UpdatePurchaseOrderInput }, PurchaseOrderView> =>
  usePurchaseWrite(storeId, input =>
    updatePurchaseOrder(apiClient, storeId, input.id, input.changes)
  )

export const useOrderPurchaseOrder = (storeId: string): Write<string, PurchaseOrderView> =>
  usePurchaseWrite(storeId, id => orderPurchaseOrder(apiClient, storeId, id))

export const useReceivePurchaseOrder = (
  storeId: string
): Write<{ id: string; input: ReceivePurchaseOrderInput }, PurchaseOrderView> =>
  usePurchaseWrite(storeId, value =>
    receivePurchaseOrder(apiClient, storeId, value.id, value.input)
  )

export const useClosePurchaseOrder = (
  storeId: string
): Write<{ id: string; input: ClosePurchaseOrderInput }, PurchaseOrderView> =>
  usePurchaseWrite(storeId, value => closePurchaseOrder(apiClient, storeId, value.id, value.input))

export const useCancelPurchaseOrder = (
  storeId: string
): Write<{ id: string; input: ClosePurchaseOrderInput }, PurchaseOrderView> =>
  usePurchaseWrite(storeId, value => cancelPurchaseOrder(apiClient, storeId, value.id, value.input))

// The returns of one payment: asked only when the person opens them
export function useSupplierPaymentReturns(
  storeId: string,
  paymentId: string,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<SupplierPaymentReturnPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.purchases.paymentReturns(storeId, paymentId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchSupplierPaymentReturns(apiClient, storeId, paymentId, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    enabled
  })
}

// A payment named by the supplier it pays, or by the purchase order whose bill it pays
export const useRecordSupplierPayment = (
  storeId: string
): Write<{ supplierId: string; input: RecordSupplierPaymentInput }, SupplierPaymentView> =>
  usePurchaseWrite(storeId, value =>
    recordSupplierPayment(apiClient, storeId, value.supplierId, value.input)
  )

export const useRecordPurchaseOrderPayment = (
  storeId: string
): Write<{ orderId: string; input: RecordSupplierPaymentInput }, SupplierPaymentView> =>
  usePurchaseWrite(storeId, value =>
    recordPurchaseOrderPayment(apiClient, storeId, value.orderId, value.input)
  )

export const useVoidSupplierPayment = (
  storeId: string
): Write<{ id: string; input: VoidSupplierPaymentInput }, SupplierPaymentView> =>
  usePurchaseWrite(storeId, value => voidSupplierPayment(apiClient, storeId, value.id, value.input))

export const useRecordPaymentReturn = (
  storeId: string
): Write<{ paymentId: string; input: RecordPaymentReturnInput }, SupplierPaymentReturnView> =>
  usePurchaseWrite(storeId, value =>
    recordSupplierPaymentReturn(apiClient, storeId, value.paymentId, value.input)
  )

export const useVoidPaymentReturn = (
  storeId: string
): Write<{ id: string; input: VoidPaymentReturnInput }, SupplierPaymentReturnView> =>
  usePurchaseWrite(storeId, value =>
    voidSupplierPaymentReturn(apiClient, storeId, value.id, value.input)
  )
