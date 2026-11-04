'use client'

import {
  type QueryClient,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { fetchMediaUrls, type MediaUrlsView, QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

import { linksIntervalMs } from './variant-wait'

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
    // A thread left open past the 15 minutes the links live still hands out working ones. While the
    // variants of a picture are being made the links are read again soon (a bounded number of times),
    // in case the event that announces them was lost.
    refetchInterval: query =>
      linksIntervalMs(query.state.data?.processed, query.state.dataUpdateCount, URLS_STALE_MS),
    gcTime: URLS_STALE_MS
  })
}

// How many times the links of a file were read (the first read, the polls and the events alike). It is
// kept by the query, so it is the same however many times the tile that shows the file is drawn. Reading
// `dataUpdatedAt` makes the tile draw again after every read, also after one that brought the same data.
export function useMediaUrlReads(
  storeId: string,
  mediaId: string,
  urls: UseQueryResult<MediaUrlsView>
): number {
  const queryClient = useQueryClient()
  if (urls.dataUpdatedAt === 0) return 0
  return queryClient.getQueryState(QueryKeys.media.urls(storeId, mediaId))?.dataUpdateCount ?? 0
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
