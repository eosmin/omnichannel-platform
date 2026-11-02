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
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationsRead,
  type NotificationPageView,
  QueryKeys
} from '@platform/api-client'
import type { NotificationFilter } from '@platform/core/notifications'

import { apiClient } from '../api'

export function useNotificationList(
  storeId: string,
  filter: NotificationFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<NotificationPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.notifications.filtered(storeId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchNotifications(apiClient, storeId, { filter, cursor: pageParam }, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    enabled
  })
}

// The number on the bell. The `NOTIFICATION` event refreshes it (lib/realtime/invalidation.ts).
export function useUnreadCount(storeId: string): UseQueryResult<number> {
  return useQuery({
    queryKey: QueryKeys.notifications.unread(storeId),
    queryFn: ({ signal }) => fetchUnreadCount(apiClient, storeId, signal)
  })
}

// Marking changes the list (the dot, the "Unread" tab) and the count: `list` is the prefix of both
function useRefreshAfter(storeId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: QueryKeys.notifications.list(storeId) })
  }
}

// `onError` lives here and not in `mutate(..., { onError })`: a click that navigates unmounts the
// row, and the callbacks of a `mutate` call do not run once its component is gone
export function useMarkRead(
  storeId: string,
  onError: () => void
): UseMutationResult<number, Error, string> {
  const refresh = useRefreshAfter(storeId)
  return useMutation({
    mutationFn: (id: string) => markNotificationsRead(apiClient, storeId, [id]),
    onSuccess: refresh,
    onError
  })
}

export function useMarkAllRead(storeId: string): UseMutationResult<number, Error, void> {
  const refresh = useRefreshAfter(storeId)
  return useMutation({
    mutationFn: () => markAllNotificationsRead(apiClient, storeId),
    onSuccess: refresh
  })
}
