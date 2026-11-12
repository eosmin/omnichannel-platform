'use client'

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import {
  cancelOrder,
  changeOrderStatus,
  confirmOrder,
  confirmUpload,
  decideOrderPrice,
  fetchMediaUrls,
  fetchOrder,
  type OrderDetailView,
  QueryKeys,
  recordOrderPayment,
  requestUploadUrl,
  updateOrder
} from '@platform/api-client'
import type {
  ChangeOrderStatusInput,
  RecordOrderPaymentInput,
  UpdateOrderInput
} from '@platform/core/domain'
import { MediaPurpose } from '@platform/core/storage'

import { apiClient } from '../api'
import { uploadToUrl } from '../media/upload-to-url'
import { waitUntilClean } from '../media/wait-until-clean'

// One order of the store, with what the member may read of it (the api leaves out the rest)
export function useOrder(
  storeId: string,
  orderId: string,
  enabled: boolean
): UseQueryResult<OrderDetailView> {
  return useQuery({
    queryKey: QueryKeys.orders.byId(storeId, orderId),
    queryFn: ({ signal }) => fetchOrder(apiClient, storeId, orderId, signal),
    enabled
  })
}

export interface OrderWrites {
  status: UseMutationResult<OrderDetailView, Error, ChangeOrderStatusInput>
  confirm: UseMutationResult<OrderDetailView, Error, string>
  cancel: UseMutationResult<OrderDetailView, Error, { reason: string; notifyCustomer?: boolean }>
  update: UseMutationResult<OrderDetailView, Error, UpdateOrderInput>
  payment: UseMutationResult<OrderDetailView, Error, RecordOrderPaymentInput>
  decidePrice: UseMutationResult<
    OrderDetailView,
    Error,
    { decision: 'approve' | 'reject'; reason?: string }
  >
}

// Every write answers with the order as it is now: that answer replaces the detail on the screen, and the pages of the list
// (the status, the payment and the total they show) are marked stale. A write that is refused leaves the screen as it was.
export function useOrderWrites(storeId: string, orderId: string): OrderWrites {
  const queryClient = useQueryClient()
  const keep = async (order: OrderDetailView): Promise<void> => {
    // A refresh that started before the write must not land after it and bring the old state back
    await queryClient.cancelQueries({ queryKey: QueryKeys.orders.byId(storeId, orderId) })
    queryClient.setQueryData(QueryKeys.orders.byId(storeId, orderId), order)
    // A status or a cancel may have told the customer: the history of messages has a new row
    void queryClient.invalidateQueries({ queryKey: QueryKeys.orders.messages(storeId, orderId) })
    // The lists hold `list` under the same root as the detail: only the pages of the list are refreshed
    void queryClient.invalidateQueries({
      queryKey: [...QueryKeys.orders.all(storeId), 'list']
    })
  }
  return {
    status: useMutation({
      mutationFn: (input: ChangeOrderStatusInput) =>
        changeOrderStatus(apiClient, storeId, orderId, input),
      onSuccess: keep
    }),
    confirm: useMutation({
      mutationFn: (via: string) => confirmOrder(apiClient, storeId, orderId, via),
      onSuccess: keep
    }),
    cancel: useMutation({
      mutationFn: ({ reason, notifyCustomer }: { reason: string; notifyCustomer?: boolean }) =>
        cancelOrder(apiClient, storeId, orderId, reason, notifyCustomer),
      onSuccess: keep
    }),
    update: useMutation({
      mutationFn: (changes: UpdateOrderInput) => updateOrder(apiClient, storeId, orderId, changes),
      onSuccess: keep
    }),
    payment: useMutation({
      mutationFn: (input: RecordOrderPaymentInput) =>
        recordOrderPayment(apiClient, storeId, orderId, input),
      onSuccess: keep
    }),
    decidePrice: useMutation({
      mutationFn: ({ decision, reason }: { decision: 'approve' | 'reject'; reason?: string }) =>
        decideOrderPrice(apiClient, storeId, orderId, decision, reason),
      onSuccess: keep
    })
  }
}

export interface UploadedOrderFile {
  mediaId: string
  filename: string
}

// A file of the order (the receipt of a payment, the proof of a delivery) by the flow of every upload: a signed url, the
// bytes straight to the bucket, a confirmation with the purpose `order` naming the order. The api only takes a file that the
// scan cleared, so this waits for the verdict (the links of the file answer FILE_NOT_READY until then) and gives the file back
// only when it is clean: an infected one or one the scan gave up on is the error of the upload. Leaving the page stops the wait.
export function useOrderFileUpload(
  storeId: string,
  orderId: string
): UseMutationResult<UploadedOrderFile, Error, File> {
  const controller = useRef<AbortController>(new AbortController())
  // One signal per mount of the effect: StrictMode mounts, cleans up and mounts again, and a signal aborted by the first
  // cleanup would fail every upload after it
  useEffect(() => {
    const current = new AbortController()
    controller.current = current
    return () => current.abort()
  }, [])
  return useMutation({
    mutationFn: async (file: File): Promise<UploadedOrderFile> => {
      const info = { filename: file.name, contentType: file.type, fileSizeBytes: file.size }
      const target = { purpose: MediaPurpose.ORDER, parentId: orderId } as const
      const { signal } = controller.current
      const signed = await requestUploadUrl(apiClient, storeId, info, target)
      await uploadToUrl(signed.uploadUrl, file, file.type, () => undefined, signal)
      await confirmUpload(
        apiClient,
        storeId,
        { ...info, mediaId: signed.mediaId, key: signed.key },
        target
      )
      await waitUntilClean(() => fetchMediaUrls(apiClient, storeId, signed.mediaId, signal), {
        signal
      })
      return { mediaId: signed.mediaId, filename: file.name }
    }
  })
}
