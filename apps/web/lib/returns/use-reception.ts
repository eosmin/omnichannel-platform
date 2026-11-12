'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  completeReceptionBatch,
  createReceptionBatch,
  fetchReceptionBatch,
  fetchReceptionBatches,
  QueryKeys,
  type ReceptionBatchSummaryView,
  type ReceptionBatchView,
  type ReceptionItemView,
  removeReceptionItem,
  type ScanResultView,
  scanReceptionCode,
  updateReceptionItem
} from '@platform/api-client'
import type { ScanCodeBody, UpdateReceptionItemBody } from '@platform/core/domain'

import { apiClient } from '../api'

// The hooks of the reception screen (TDD_17 §4.16). Only that page loads this file. Every write brings the batch back from
// the api: the server decides what each package is, so the screen draws what it answers and keeps no copy of its own.

export function useReceptionBatches(
  storeId: string,
  enabled: boolean
): UseQueryResult<ReceptionBatchSummaryView[]> {
  return useQuery({
    queryKey: QueryKeys.returns.receptionBatches(storeId),
    queryFn: ({ signal }) => fetchReceptionBatches(apiClient, storeId, undefined, signal),
    enabled
  })
}

export function useReceptionBatch(
  storeId: string,
  batchId: string | null
): UseQueryResult<ReceptionBatchView> {
  return useQuery({
    queryKey: QueryKeys.returns.receptionBatch(storeId, batchId ?? ''),
    queryFn: ({ signal }) => fetchReceptionBatch(apiClient, storeId, batchId ?? '', signal),
    enabled: batchId !== null
  })
}

export interface ReceptionWrites {
  start: UseMutationResult<ReceptionBatchView, Error, void>
  scan: UseMutationResult<ScanResultView, Error, ScanCodeBody>
  update: UseMutationResult<
    ReceptionItemView,
    Error,
    { itemId: string; body: UpdateReceptionItemBody }
  >
  remove: UseMutationResult<void, Error, string>
  complete: UseMutationResult<ReceptionBatchView, Error, void>
}

export function useReceptionWrites(storeId: string, batchId: string | null): ReceptionWrites {
  const queryClient = useQueryClient()
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: QueryKeys.returns.receptionBatches(storeId) })
  const requireBatch = (): string => {
    if (batchId === null) throw new Error('there is no batch to write to')
    return batchId
  }
  return {
    start: useMutation({
      mutationFn: () => createReceptionBatch(apiClient, storeId),
      onSuccess: refresh
    }),
    scan: useMutation({
      mutationFn: (body: ScanCodeBody) =>
        scanReceptionCode(apiClient, storeId, requireBatch(), body),
      onSuccess: refresh
    }),
    update: useMutation({
      mutationFn: ({ itemId, body }: { itemId: string; body: UpdateReceptionItemBody }) =>
        updateReceptionItem(apiClient, storeId, requireBatch(), itemId, body),
      onSuccess: refresh
    }),
    remove: useMutation({
      mutationFn: (itemId: string) =>
        removeReceptionItem(apiClient, storeId, requireBatch(), itemId),
      onSuccess: refresh
    }),
    complete: useMutation({
      mutationFn: () => completeReceptionBatch(apiClient, storeId, requireBatch()),
      // A returns list drawn before the batch closed is out of date now: the packages became returns
      onSuccess: () => queryClient.invalidateQueries({ queryKey: QueryKeys.returns.all(storeId) })
    })
  }
}
