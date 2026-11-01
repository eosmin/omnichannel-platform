import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type { BulkActions, ConversationStatus } from '@platform/core/domain'

import type { ApiClient } from './api-client'
import {
  type TagView,
  tagListSchema,
  type BulkResultView,
  bulkResultSchema,
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
  type InboxBehaviorView,
  inboxBehaviorSchema,
  type MemberDirectoryEntryView,
  memberDirectorySchema,
  type MessagingWindowView,
  messagingWindowSchema,
  type SnippetView,
  snippetListSchema
} from './api-schemas'
import type { ConversationFilters } from './query-keys'

// The query string of the list: only what the filters name, in a fixed order
function listQuery(filters: ConversationFilters, cursor: string | null): string {
  const params = new URLSearchParams()
  if (filters.assigned !== undefined) params.set('assigned', filters.assigned)
  if (filters.status !== undefined) params.set('status', filters.status)
  if (filters.channelType !== undefined) params.set('channelType', filters.channelType)
  if (filters.tagId !== undefined) params.set('tagId', filters.tagId)
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

export function fetchTags(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<TagView[]> {
  return client.request(ApiRoutes.settings.tags, { schema: tagListSchema, storeId, signal })
}

export function fetchSnippets(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<SnippetView[]> {
  return client.request(ApiRoutes.settings.snippets, {
    schema: snippetListSchema,
    storeId,
    signal
  })
}

export function fetchInboxBehavior(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<InboxBehaviorView> {
  return client.request(ApiRoutes.settings.inboxBehavior, {
    schema: inboxBehaviorSchema,
    storeId,
    signal
  })
}

// The answer of each action below is the detail; the screens read the list and the thread again
// What PATCH /status takes: a snooze has its own route, which needs the moment it ends
export type SettableConversationStatus = Exclude<ConversationStatus, ConversationStatus.SNOOZED>

export function changeConversationStatus(
  client: ApiClient,
  storeId: string,
  conversationId: string,
  status: SettableConversationStatus,
  // With RESOLVED only. The closing message is sent by the server once the time to undo is over.
  options: { resolutionReason?: string; closingSnippetId?: string } = {}
): Promise<ConversationDetailView> {
  return client.request(ApiRoutes.conversations.status(conversationId), {
    method: 'PATCH',
    body: { status, ...options },
    schema: conversationDetailSchema,
    storeId
  })
}

export function snoozeConversation(
  client: ApiClient,
  storeId: string,
  conversationId: string,
  until: Date
): Promise<ConversationDetailView> {
  return client.request(ApiRoutes.conversations.snooze(conversationId), {
    method: 'POST',
    body: { until: until.toISOString() },
    schema: conversationDetailSchema,
    storeId
  })
}

// `userId` null takes the conversation away from whoever holds it
export function assignConversation(
  client: ApiClient,
  storeId: string,
  conversationId: string,
  userId: string | null
): Promise<ConversationDetailView> {
  return client.request(ApiRoutes.conversations.assign(conversationId), {
    method: 'PATCH',
    body: { userId },
    schema: conversationDetailSchema,
    storeId
  })
}

type NoParamsBulkAction =
  | typeof BulkActions.ASSIGN_TO_ME
  | typeof BulkActions.UNASSIGN
  | typeof BulkActions.MARK_READ
  | typeof BulkActions.MARK_UNREAD
  | typeof BulkActions.ARCHIVE
  | typeof BulkActions.EXPORT_CSV

// What a bulk action does: the ones that take no parameter, and each of the others with its own.
// Snoozing and spam are not here: the server does not take them in bulk. The export makes a file in the
// exports center instead of changing the conversations.
export type BulkOperation =
  | { action: NoParamsBulkAction }
  | { action: typeof BulkActions.ASSIGN_TO_AGENT; params: { userId: string } }
  | { action: typeof BulkActions.ROUND_ROBIN_TO_TEAM; params: { userIds: string[] } }
  | {
      action: typeof BulkActions.SET_STATUS
      params: {
        status: ConversationStatus.OPEN | ConversationStatus.PENDING | ConversationStatus.RESOLVED
      }
    }
  | {
      action: typeof BulkActions.ADD_TAG | typeof BulkActions.REMOVE_TAG
      params: { tagId: string }
    }

// The conversations it reaches: the ones named, or the ones that match a filter (the server caps both
// at BulkLimits.MAX_ITEMS). A filter must name at least one field.
export type BulkTarget = { conversationIds: string[] } | { filter: ConversationFilters }

export function bulkConversations(
  client: ApiClient,
  storeId: string,
  operation: BulkOperation,
  target: BulkTarget
): Promise<BulkResultView> {
  return client.request(ApiRoutes.conversations.bulk, {
    method: 'POST',
    body: { ...operation, ...target },
    schema: bulkResultSchema,
    storeId
  })
}
