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
  type ChannelTemplateView,
  type ConversationCountsView,
  type ConversationOriginView,
  type ConversationFilters,
  type ConversationDetailView,
  type ConversationPageView,
  type InboxBehaviorView,
  fetchChannelDirectory,
  fetchChannelTemplates,
  fetchConversation,
  fetchConversationCounts,
  fetchConversationOrigins,
  fetchConversationsPage,
  fetchInboxBehavior,
  fetchSnippets,
  fetchTags,
  fetchMemberDirectory,
  fetchMessagesPage,
  fetchMessagingWindow,
  type MemberDirectoryEntryView,
  type MessagePageView,
  type MessagingWindowView,
  QueryKeys,
  type SnippetView,
  type TagView
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
): UseQueryResult<ConversationDetailView> {
  return useQuery({
    queryKey: QueryKeys.conversations.byId(storeId, conversationId),
    queryFn: ({ signal }) => fetchConversation(apiClient, storeId, conversationId, signal)
  })
}

// The thread is read page by page, newest first; a realtime event makes the whole key stale, which
// refetches the pages that are loaded
export function useThread(
  storeId: string,
  conversationId: string
): UseInfiniteQueryResult<InfiniteData<MessagePageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.messages.thread(storeId, conversationId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchMessagesPage(apiClient, storeId, conversationId, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined)
  })
}

export function useOrigins(
  storeId: string,
  conversationId: string
): UseQueryResult<ConversationOriginView[]> {
  return useQuery({
    queryKey: QueryKeys.messages.origins(storeId, conversationId),
    queryFn: ({ signal }) => fetchConversationOrigins(apiClient, storeId, conversationId, signal)
  })
}

// The name of the channel of a conversation, from the plugin that serves it; its id until the
// directory is read
export function useChannelName(storeId: string, channelType: string): string {
  const channels = useChannelDirectory(storeId)
  return channels.data?.find(channel => channel.pluginId === channelType)?.pluginName ?? channelType
}

export function useMessagingWindow(
  storeId: string,
  conversationId: string
): UseQueryResult<MessagingWindowView> {
  return useQuery({
    queryKey: QueryKeys.messages.window(storeId, conversationId),
    queryFn: ({ signal }) => fetchMessagingWindow(apiClient, storeId, conversationId, signal)
  })
}

// Read when the dialog of templates opens, not before: most conversations never need them
export function useChannelTemplates(
  storeId: string,
  pluginId: string,
  connectionId: string
): UseQueryResult<ChannelTemplateView[]> {
  return useQuery({
    queryKey: QueryKeys.channels.templates(storeId, pluginId, connectionId),
    queryFn: ({ signal }) =>
      fetchChannelTemplates(apiClient, storeId, pluginId, connectionId, signal)
  })
}

// Read when the composer opens a snippet menu or a resolve starts, not with the conversation
export function useSnippets(storeId: string, isEnabled: boolean): UseQueryResult<SnippetView[]> {
  return useQuery({
    queryKey: QueryKeys.snippets.all(storeId),
    queryFn: ({ signal }) => fetchSnippets(apiClient, storeId, signal),
    enabled: isEnabled
  })
}

export function useInboxBehavior(storeId: string): UseQueryResult<InboxBehaviorView> {
  return useQuery({
    queryKey: QueryKeys.inboxBehavior.store(storeId),
    queryFn: ({ signal }) => fetchInboxBehavior(apiClient, storeId, signal)
  })
}

// The tags of the store, for the filter of the list. Any agent who sees conversations reads them.
export function useTags(storeId: string): UseQueryResult<TagView[]> {
  return useQuery({
    queryKey: QueryKeys.tags.all(storeId),
    queryFn: ({ signal }) => fetchTags(apiClient, storeId, signal)
  })
}
