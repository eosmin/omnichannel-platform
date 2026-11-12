'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useQuery,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  fetchReturn,
  fetchReturns,
  QueryKeys,
  type ReturnPageView,
  type ReturnView
} from '@platform/api-client'

import { apiClient } from '../api'

import { type ReturnsFilterDraft, returnsListParams } from './returns-filter'

// The hooks of the returns screens (the list and the detail). Only those pages load this file.

export const RETURNS_PAGE = 25

export function useReturns(
  storeId: string,
  filter: ReturnsFilterDraft,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<ReturnPageView, string | null>> {
  const params = returnsListParams(filter)
  return useInfiniteQuery({
    queryKey: QueryKeys.returns.list(storeId, params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchReturns(
        apiClient,
        storeId,
        { ...params, cursor: pageParam, limit: RETURNS_PAGE },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

export function useReturn(
  storeId: string,
  returnId: string,
  enabled: boolean
): UseQueryResult<ReturnView> {
  return useQuery({
    queryKey: QueryKeys.returns.detail(storeId, returnId),
    queryFn: ({ signal }) => fetchReturn(apiClient, storeId, returnId, signal),
    enabled
  })
}
