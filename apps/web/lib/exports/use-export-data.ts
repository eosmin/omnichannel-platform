'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult
} from '@tanstack/react-query'

import {
  type ExportListFilter,
  type ExportPageView,
  fetchExports,
  QueryKeys
} from '@platform/api-client'
import { ExportStatus } from '@platform/core/exports'

import { apiClient } from '../api'

// How often the list is asked again while a file is being prepared
const PROGRESS_POLL_MS = 3000

export function useExportList(
  storeId: string,
  filter: ExportListFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<ExportPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.exports.list(storeId, filter.type, filter.status),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchExports(apiClient, storeId, filter, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    // A file being written moves its bar: ask again while any row on the page is still pending
    refetchInterval: query =>
      query.state.data?.pages.some(page =>
        page.data.some(item => item.status === ExportStatus.PENDING)
      )
        ? PROGRESS_POLL_MS
        : false,
    enabled
  })
}
