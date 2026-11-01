'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult
} from '@tanstack/react-query'

import { type ExportPageView, fetchExports, QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

import { EXPORT_POLL_MS, hasPendingExport } from './export-state'

export function useExportList(
  storeId: string,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<ExportPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.exports.all(storeId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchExports(apiClient, storeId, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    // Asks again while something is being made, and stops when nothing is
    refetchInterval: query =>
      hasPendingExport(query.state.data?.pages.flatMap(page => page.data) ?? [])
        ? EXPORT_POLL_MS
        : false,
    enabled
  })
}
