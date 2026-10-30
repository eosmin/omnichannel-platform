import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import {
  type ChannelDirectoryEntryView,
  channelDirectorySchema,
  type ConversationCountsView,
  type ConversationListItemView,
  conversationListItemSchema,
  conversationCountsSchema,
  type ConversationPageView,
  conversationPageSchema,
  type MemberDirectoryEntryView,
  memberDirectorySchema
} from './api-schemas'
import type { ConversationFilters } from './query-keys'

// The query string of the list: only what the filters name, in a fixed order
function listQuery(filters: ConversationFilters, cursor: string | null): string {
  const params = new URLSearchParams()
  if (filters.assigned !== undefined) params.set('assigned', filters.assigned)
  if (filters.status !== undefined) params.set('status', filters.status)
  if (filters.channelType !== undefined) params.set('channelType', filters.channelType)
  if (cursor !== null) params.set('cursor', cursor)
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export function fetchConversationsPage(
  client: ApiClient,
  storeId: string,
  filters: ConversationFilters,
  cursor: string | null,
  signal?: AbortSignal
): Promise<ConversationPageView> {
  return client.request(`${ApiRoutes.conversations.list}${listQuery(filters, cursor)}`, {
    schema: conversationPageSchema,
    storeId,
    signal
  })
}

// One conversation, as the list shows it (the detail adds fields this page does not read yet)
export function fetchConversation(
  client: ApiClient,
  storeId: string,
  conversationId: string,
  signal?: AbortSignal
): Promise<ConversationListItemView> {
  return client.request(ApiRoutes.conversations.byId(conversationId), {
    schema: conversationListItemSchema,
    storeId,
    signal
  })
}

export function fetchConversationCounts(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<ConversationCountsView> {
  return client.request(`${ApiRoutes.conversations.list}?countsOnly=true`, {
    schema: conversationCountsSchema,
    storeId,
    signal
  })
}

export function fetchMemberDirectory(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<MemberDirectoryEntryView[]> {
  return client.request(ApiRoutes.members.directory, {
    schema: memberDirectorySchema,
    storeId,
    signal
  })
}

export function fetchChannelDirectory(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<ChannelDirectoryEntryView[]> {
  return client.request(ApiRoutes.channels.directory, {
    schema: channelDirectorySchema,
    storeId,
    signal
  })
}
