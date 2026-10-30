import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import {
  type ChannelDirectoryEntryView,
  channelDirectorySchema,
  type ChannelTemplateView,
  channelTemplateListSchema,
  type ConversationCountsView,
  type ConversationOriginView,
  conversationOriginListSchema,
  type ConversationDetailView,
  conversationDetailSchema,
  conversationCountsSchema,
  type ConversationPageView,
  conversationPageSchema,
  type MemberDirectoryEntryView,
  memberDirectorySchema,
  type MessagingWindowView,
  messagingWindowSchema
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
): Promise<ConversationDetailView> {
  return client.request(ApiRoutes.conversations.byId(conversationId), {
    schema: conversationDetailSchema,
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

// Where the conversation came from, newest first (the card on top of the thread)
export function fetchConversationOrigins(
  client: ApiClient,
  storeId: string,
  conversationId: string,
  signal?: AbortSignal
): Promise<ConversationOriginView[]> {
  return client.request(ApiRoutes.conversations.origins(conversationId), {
    schema: conversationOriginListSchema,
    storeId,
    signal
  })
}

// Marks the conversation read for the whole team; the answer is the detail, which this page reads
// again through the list
export async function markConversationRead(
  client: ApiClient,
  storeId: string,
  conversationId: string
): Promise<void> {
  await client.request(ApiRoutes.conversations.read(conversationId), {
    method: 'POST',
    schema: z.unknown(),
    storeId
  })
}

export function fetchMessagingWindow(
  client: ApiClient,
  storeId: string,
  conversationId: string,
  signal?: AbortSignal
): Promise<MessagingWindowView> {
  return client.request(ApiRoutes.conversations.messagingWindow(conversationId), {
    schema: messagingWindowSchema,
    storeId,
    signal
  })
}

// The templates of one account of a channel: they belong to the account, not to the plugin
export function fetchChannelTemplates(
  client: ApiClient,
  storeId: string,
  pluginId: string,
  connectionId: string,
  signal?: AbortSignal
): Promise<ChannelTemplateView[]> {
  const query = new URLSearchParams({ connectionId }).toString()
  return client.request(`${ApiRoutes.channels.templates(pluginId)}?${query}`, {
    schema: channelTemplateListSchema,
    storeId,
    signal
  })
}
