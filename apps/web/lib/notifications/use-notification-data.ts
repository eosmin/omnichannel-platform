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
  fetchNotificationPreferences,
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationsRead,
  type NotificationPageView,
  type NotificationPreferencesPatch,
  type NotificationPreferencesView,
  putNotificationPreferences,
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

const PREFERENCES_MUTATION = ['notifications', 'save-preferences'] as const

export function usePreferences(storeId: string): UseQueryResult<NotificationPreferencesView> {
  return useQuery({
    queryKey: QueryKeys.notifications.preferences(storeId),
    queryFn: ({ signal }) => fetchNotificationPreferences(apiClient, storeId, signal)
  })
}

// Each change saves at once. The page shows the new value before the api answers and goes back to
// the stored one if it refuses; the answer of the api is read again at the end, so two quick changes
// that settle out of order cannot leave the page on the older one.
export function useSavePreferences(
  storeId: string,
  onError: () => void
): UseMutationResult<
  NotificationPreferencesView,
  Error,
  NotificationPreferencesPatch,
  { before: NotificationPreferencesView | undefined }
> {
  const queryClient = useQueryClient()
  const key = QueryKeys.notifications.preferences(storeId)
  return useMutation({
    mutationKey: PREFERENCES_MUTATION,
    mutationFn: (patch: NotificationPreferencesPatch) =>
      putNotificationPreferences(apiClient, storeId, patch),
    onMutate: async patch => {
      await queryClient.cancelQueries({ queryKey: key })
      const before = queryClient.getQueryData<NotificationPreferencesView>(key)
      if (before !== undefined) {
        queryClient.setQueryData<NotificationPreferencesView>(key, {
          types: before.types.map(row => ({
            ...row,
            ...(patch.types?.find(changed => changed.type === row.type) ?? {})
          })),
          settings: { ...before.settings, ...patch.settings }
        })
      }
      return { before }
    },
    // No snapshot is put back: another change may be in flight on top of it, and the api's answer
    // (read again at the end) is the truth
    onError,
    onSettled: () => {
      // Only the last change to settle reads again, so an older answer cannot cover a newer change.
      // The settings are the person's in every store: the matrix of the others is read again too.
      if (queryClient.isMutating({ mutationKey: PREFERENCES_MUTATION }) > 1) return
      return queryClient.invalidateQueries({
        predicate: query =>
          query.queryKey[0] === 'notifications' && query.queryKey[2] === 'preferences'
      })
    }
  })
}
