'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult
} from '@tanstack/react-query'

import {
  type ExportView,
  fetchCustomerMedia,
  type GalleryPageView,
  QueryKeys,
  requestMediaZip
} from '@platform/api-client'
import type { GalleryType } from '@platform/core/storage'

import { apiClient } from '../api'

// The files of a customer under a tab and a search, a page at a time. The counts of the tabs come
// with the first page only; `countsOf` keeps them.
export function useGallery(
  storeId: string,
  customerId: string,
  type: GalleryType,
  q: string
): UseInfiniteQueryResult<InfiniteData<GalleryPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.customers.media(storeId, customerId, type, q.trim()),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchCustomerMedia(apiClient, storeId, customerId, { type, q }, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined)
  })
}

// "Download all": queues the ZIP of what the gallery shows
export function useDownloadAll(
  storeId: string,
  customerId: string
): UseMutationResult<ExportView, Error, { type: GalleryType; q: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (filter: { type: GalleryType; q: string }) =>
      requestMediaZip(apiClient, storeId, { customerId, ...filter }),
    // The exports center shows the new row the moment the person gets there
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.exports.all(storeId) })
    }
  })
}
