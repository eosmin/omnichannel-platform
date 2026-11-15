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
  type BenefitPeriodView,
  type BenefitView,
  fetchBenefit,
  fetchBenefitPeriods,
  fetchGuideBalance,
  fetchGuideMovements,
  fetchGuidePolicy,
  type GuideBalanceView,
  type GuideMovementPage,
  type GuideMovementView,
  type GuidePolicyView,
  putGuidePolicy,
  QueryKeys,
  recordGuideAdjustment,
  recordGuidePurchase,
  voidGuidePurchase
} from '@platform/api-client'
import type {
  GuidePolicyBody,
  RecordGuideAdjustmentBody,
  RecordGuidePurchaseBody,
  VoidGuidePurchaseBody
} from '@platform/core/domain'

import { apiClient } from '../api'

// The hooks of the guide balance and the refund benefit of one connection (TDD_17 §4.18). Only the carriers page loads this
// file. Reads ask for carriers:view_guide_balance, so a caller passes `enabled` false for a person without it and no request
// goes out. Every write makes the connection's balance, movements, benefit and policy stale together.

type MovementPages = InfiniteData<GuideMovementPage, string | null>

export function useGuideBalance(
  storeId: string,
  connectionId: string,
  enabled: boolean
): UseQueryResult<GuideBalanceView> {
  return useQuery({
    queryKey: QueryKeys.carriers.guideBalance(storeId, connectionId),
    queryFn: ({ signal }) => fetchGuideBalance(apiClient, storeId, connectionId, signal),
    enabled
  })
}

export function useGuideMovements(
  storeId: string,
  connectionId: string,
  enabled: boolean
): UseInfiniteQueryResult<MovementPages> {
  return useInfiniteQuery({
    queryKey: QueryKeys.carriers.guideMovements(storeId, connectionId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchGuideMovements(
        apiClient,
        storeId,
        connectionId,
        pageParam === null ? {} : { cursor: pageParam },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    enabled
  })
}

export function useGuidePolicy(
  storeId: string,
  connectionId: string,
  enabled: boolean
): UseQueryResult<GuidePolicyView> {
  return useQuery({
    queryKey: QueryKeys.carriers.guidePolicy(storeId, connectionId),
    queryFn: ({ signal }) => fetchGuidePolicy(apiClient, storeId, connectionId, signal),
    enabled
  })
}

export function useBenefit(
  storeId: string,
  connectionId: string,
  enabled: boolean
): UseQueryResult<BenefitView> {
  return useQuery({
    queryKey: QueryKeys.carriers.benefit(storeId, connectionId),
    queryFn: ({ signal }) => fetchBenefit(apiClient, storeId, connectionId, signal),
    enabled
  })
}

export function useBenefitPeriods(
  storeId: string,
  connectionId: string,
  enabled: boolean
): UseQueryResult<BenefitPeriodView[]> {
  return useQuery({
    queryKey: QueryKeys.carriers.benefitPeriods(storeId, connectionId),
    queryFn: ({ signal }) => fetchBenefitPeriods(apiClient, storeId, connectionId, signal),
    enabled
  })
}

// Not awaited: a slow read must never hold back the answer of a write
function useRefresh(storeId: string, connectionId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    for (const queryKey of [
      QueryKeys.carriers.guideBalance(storeId, connectionId),
      QueryKeys.carriers.guideMovements(storeId, connectionId),
      QueryKeys.carriers.guidePolicy(storeId, connectionId),
      QueryKeys.carriers.benefit(storeId, connectionId),
      QueryKeys.carriers.benefitPeriods(storeId, connectionId)
    ]) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
}

export function useRecordPurchase(
  storeId: string,
  connectionId: string
): UseMutationResult<GuideMovementView, Error, RecordGuidePurchaseBody> {
  const refresh = useRefresh(storeId, connectionId)
  return useMutation({
    mutationFn: (body: RecordGuidePurchaseBody) =>
      recordGuidePurchase(apiClient, storeId, connectionId, body),
    onSuccess: refresh
  })
}

export function useRecordAdjustment(
  storeId: string,
  connectionId: string
): UseMutationResult<GuideMovementView, Error, RecordGuideAdjustmentBody> {
  const refresh = useRefresh(storeId, connectionId)
  return useMutation({
    mutationFn: (body: RecordGuideAdjustmentBody) =>
      recordGuideAdjustment(apiClient, storeId, connectionId, body),
    onSuccess: refresh
  })
}

export interface VoidInput {
  movementId: string
  body: VoidGuidePurchaseBody
}

export function useVoidPurchase(
  storeId: string,
  connectionId: string
): UseMutationResult<GuideMovementView, Error, VoidInput> {
  const refresh = useRefresh(storeId, connectionId)
  return useMutation({
    mutationFn: (input: VoidInput) =>
      voidGuidePurchase(apiClient, storeId, connectionId, input.movementId, input.body),
    onSuccess: refresh
  })
}

export function useSavePolicy(
  storeId: string,
  connectionId: string
): UseMutationResult<GuidePolicyView, Error, GuidePolicyBody> {
  const refresh = useRefresh(storeId, connectionId)
  return useMutation({
    mutationFn: (body: GuidePolicyBody) => putGuidePolicy(apiClient, storeId, connectionId, body),
    onSuccess: refresh
  })
}
