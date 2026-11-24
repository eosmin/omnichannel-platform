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
import { useEffect } from 'react'

import { QueryKeys } from '@platform/api-client'
import { type DsrDecision, DsrDecisions, DsrReviewLimits } from '@platform/core/domain'

import { apiClient } from '../api'

import {
  approveDsrRequest,
  cancelDsrErasure,
  type DsrRequestDetailView,
  type DsrRequestPageView,
  type DsrRequestView,
  fetchDsrExportLink,
  fetchDsrRequest,
  fetchDsrRequests,
  rejectDsrRequest
} from './dsr-requests'

// How often the open queue is read again while the page is in view: a request that is verified or that ends elsewhere (the person's
// mail, a sweep, another reviewer) changes the list with nobody on this screen to see it (PRI-076). A hidden tab does not poll.
export const DSR_QUEUE_REFRESH_MS = 30_000
export const DSR_QUEUE_POLL_MAX_PAGES = 3

// The whole queue, newest first. The banners and the marks count every request, so the pages are read one after the other until the
// api says there are no more (up to MAX_AUTO_PAGES of 100; a store with more asks for the rest by hand).
export function useDsrQueue(
  storeId: string
): UseInfiniteQueryResult<InfiniteData<DsrRequestPageView, string | null>> {
  const query = useInfiniteQuery<
    DsrRequestPageView,
    Error,
    InfiniteData<DsrRequestPageView, string | null>,
    ReturnType<typeof QueryKeys.dsr.list>,
    string | null
  >({
    queryKey: QueryKeys.dsr.list(storeId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchDsrRequests(apiClient, storeId, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    // Only a queue that fits a few pages is polled: a refetch reads every loaded page, one after the other
    refetchInterval: query =>
      (query.state.data?.pages.length ?? 0) <= DSR_QUEUE_POLL_MAX_PAGES
        ? DSR_QUEUE_REFRESH_MS
        : false,
    refetchOnWindowFocus: true
  })
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query
  const loaded = query.data?.pages.length ?? 0
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError && loaded < DsrReviewLimits.MAX_AUTO_PAGES) {
      void fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, isError, loaded, fetchNextPage])
  return query
}

export function useDsrRequest(storeId: string, id: string): UseQueryResult<DsrRequestDetailView> {
  return useQuery({
    queryKey: QueryKeys.dsr.one(storeId, id),
    queryFn: ({ signal }) => fetchDsrRequest(apiClient, storeId, id, signal)
  })
}

const DECIDERS = {
  [DsrDecisions.APPROVE]: approveDsrRequest,
  [DsrDecisions.REJECT]: rejectDsrRequest,
  [DsrDecisions.CANCEL]: cancelDsrErasure
} as const

// A decision on a request. Whatever the answer (even a refusal because someone decided first) the queue and the detail are read again:
// the screen never keeps a state that the api has left behind.
export function useDsrDecision(
  storeId: string,
  decision: DsrDecision
): UseMutationResult<DsrRequestView, Error, { id: string; reason: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      DECIDERS[decision](apiClient, storeId, id, reason),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QueryKeys.dsr.all(storeId) })
  })
}

// The signed link to the file of a finished access or portability request: asked each time, it lasts minutes
export function requestDsrExportLink(storeId: string, id: string): Promise<{ url: string }> {
  return fetchDsrExportLink(apiClient, storeId, id)
}
