'use client'

import { type QueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query'

import { fetchMediaUrls, type MediaUrlsView, QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

// The links expire after 15 minutes; a query kept for 10 never hands out one that is about to die
const URLS_STALE_MS = 10 * 60_000

// The signed links of a file, asked only when the file is clean (before that the api answers 409)
export function useMediaUrls(
  storeId: string,
  mediaId: string,
  enabled: boolean
): UseQueryResult<MediaUrlsView> {
  return useQuery({
    queryKey: QueryKeys.media.urls(storeId, mediaId),
    queryFn: ({ signal }) => fetchMediaUrls(apiClient, storeId, mediaId, signal),
    enabled,
    staleTime: URLS_STALE_MS,
    // A thread left open past the 15 minutes the links live still hands out working ones
    refetchInterval: URLS_STALE_MS,
    gcTime: URLS_STALE_MS
  })
}

// The same links, asked when a button is pressed (a download) instead of when a tile is drawn
export function fetchMediaUrlsOnDemand(
  queryClient: QueryClient,
  storeId: string,
  mediaId: string
): Promise<MediaUrlsView> {
  return queryClient.fetchQuery({
    queryKey: QueryKeys.media.urls(storeId, mediaId),
    queryFn: ({ signal }) => fetchMediaUrls(apiClient, storeId, mediaId, signal),
    staleTime: URLS_STALE_MS
  })
}
