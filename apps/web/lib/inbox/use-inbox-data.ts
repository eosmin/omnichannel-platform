'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useQuery,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type ChannelDirectoryEntryView,
  type ConversationCountsView,
  type ConversationFilters,
  type ConversationListItemView,
  type ConversationPageView,
  fetchChannelDirectory,
  fetchConversation,
  fetchConversationCounts,
  fetchConversationsPage,
  fetchMemberDirectory,
  type MemberDirectoryEntryView,
  QueryKeys
} from '@platform/api-client'

import { apiClient } from '../api'

// The list is read page by page; a realtime event makes the whole `conversations` key of the store
// stale (invalidation.ts), which refetches the pages that are loaded
export function useConversationPages(
  storeId: string,
  filters: ConversationFilters
): UseInfiniteQueryResult<InfiniteData<ConversationPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.conversations.list(storeId, filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchConversationsPage(apiClient, storeId, filters, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined)
  })
}

export function useConversationCounts(storeId: string): UseQueryResult<ConversationCountsView> {
  return useQuery({
    queryKey: QueryKeys.conversations.counts(storeId),
    queryFn: ({ signal }) => fetchConversationCounts(apiClient, storeId, signal)
  })
}

export function useMemberDirectory(storeId: string): UseQueryResult<MemberDirectoryEntryView[]> {
  return useQuery({
    queryKey: QueryKeys.members.directory(storeId),
    queryFn: ({ signal }) => fetchMemberDirectory(apiClient, storeId, signal)
  })
}

export function useChannelDirectory(storeId: string): UseQueryResult<ChannelDirectoryEntryView[]> {
  return useQuery({
    queryKey: QueryKeys.channels.directory(storeId),
    queryFn: ({ signal }) => fetchChannelDirectory(apiClient, storeId, signal)
  })
}

export function useConversation(
  storeId: string,
  conversationId: string
): UseQueryResult<ConversationListItemView> {
  return useQuery({
    queryKey: QueryKeys.conversations.byId(storeId, conversationId),
    queryFn: ({ signal }) => fetchConversation(apiClient, storeId, conversationId, signal)
  })
}
