'use client'

import {
  type QueryClient,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

import { ContentKeys } from './content-keys'
import {
  fetchInboxSettings,
  fetchPreferences,
  type InboxSettingsInput,
  type InboxSettingsView,
  type PreferencesView,
  saveInboxSettings,
  savePreferences
} from './inbox-requests'
import {
  createStoreSnippet,
  deleteStoreSnippet,
  fetchStoreSnippets,
  type SnippetInput,
  type StoreSnippetView,
  updateStoreSnippet
} from './snippets-requests'
import {
  createStoreTag,
  deleteStoreTag,
  fetchStoreTags,
  type StoreTagView,
  type TagInput,
  updateStoreTag
} from './tags-requests'

// The hooks of Settings → Tags, Snippets and Inbox behavior. Only those pages load this file.

// After a write the lists of the inbox (filters, composer, resolve flow) are read again as well: they
// hold the same data under other keys. A snippet or a tag that left must not stay in a menu.
function refreshTags(queryClient: QueryClient, storeId: string, removed = false): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ContentKeys.tags(storeId) }),
    queryClient.invalidateQueries({ queryKey: QueryKeys.tags.all(storeId) }),
    // A deleted tag leaves every conversation and customer that had it
    ...(removed
      ? [
          queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) }),
          queryClient.invalidateQueries({ queryKey: QueryKeys.customers.all(storeId) })
        ]
      : [])
  ])
}

function refreshSnippets(queryClient: QueryClient, storeId: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ContentKeys.snippets(storeId) }),
    queryClient.invalidateQueries({ queryKey: QueryKeys.snippets.all(storeId) }),
    // The closing and away messages point at a snippet
    queryClient.invalidateQueries({ queryKey: ContentKeys.inbox(storeId) }),
    queryClient.invalidateQueries({ queryKey: QueryKeys.inboxBehavior.store(storeId) })
  ])
}

export function useStoreTags(storeId: string): UseQueryResult<StoreTagView[]> {
  return useQuery({
    queryKey: ContentKeys.tags(storeId),
    queryFn: ({ signal }) => fetchStoreTags(apiClient, storeId, signal)
  })
}

export function useCreateTag(storeId: string): UseMutationResult<StoreTagView, Error, TagInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TagInput) => createStoreTag(apiClient, storeId, input),
    onSuccess: () => refreshTags(queryClient, storeId)
  })
}

export function useUpdateTag(
  storeId: string
): UseMutationResult<StoreTagView, Error, { tagId: string; input: Partial<TagInput> }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tagId, input }) => updateStoreTag(apiClient, storeId, tagId, input),
    // Settled: a tag deleted by someone else is gone from the list
    onSettled: () => refreshTags(queryClient, storeId)
  })
}

export function useDeleteTag(storeId: string): UseMutationResult<undefined, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (tagId: string) => deleteStoreTag(apiClient, storeId, tagId),
    onSettled: () => refreshTags(queryClient, storeId, true)
  })
}

export function useStoreSnippets(
  storeId: string,
  enabled = true
): UseQueryResult<StoreSnippetView[]> {
  return useQuery({
    queryKey: ContentKeys.snippets(storeId),
    queryFn: ({ signal }) => fetchStoreSnippets(apiClient, storeId, signal),
    enabled
  })
}

export function useCreateSnippet(
  storeId: string
): UseMutationResult<StoreSnippetView, Error, SnippetInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: SnippetInput) => createStoreSnippet(apiClient, storeId, input),
    onSuccess: () => refreshSnippets(queryClient, storeId)
  })
}

export function useUpdateSnippet(
  storeId: string
): UseMutationResult<StoreSnippetView, Error, { snippetId: string; input: Partial<SnippetInput> }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ snippetId, input }) => updateStoreSnippet(apiClient, storeId, snippetId, input),
    onSettled: () => refreshSnippets(queryClient, storeId)
  })
}

export function useDeleteSnippet(storeId: string): UseMutationResult<undefined, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (snippetId: string) => deleteStoreSnippet(apiClient, storeId, snippetId),
    onSettled: () => refreshSnippets(queryClient, storeId)
  })
}

export function useInboxSettings(storeId: string): UseQueryResult<InboxSettingsView> {
  return useQuery({
    queryKey: ContentKeys.inbox(storeId),
    queryFn: ({ signal }) => fetchInboxSettings(apiClient, storeId, signal)
  })
}

export function usePreferences(storeId: string): UseQueryResult<PreferencesView> {
  return useQuery({
    queryKey: ContentKeys.preferences(storeId),
    queryFn: ({ signal }) => fetchPreferences(apiClient, storeId, signal)
  })
}

export function useSaveInboxSettings(
  storeId: string
): UseMutationResult<InboxSettingsView, Error, InboxSettingsInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: InboxSettingsInput) => saveInboxSettings(apiClient, storeId, input),
    onSuccess: view => {
      queryClient.setQueryData(ContentKeys.inbox(storeId), view)
      return queryClient.invalidateQueries({ queryKey: QueryKeys.inboxBehavior.store(storeId) })
    }
  })
}

export function useSavePreferences(
  storeId: string
): UseMutationResult<PreferencesView, Error, Partial<PreferencesView>> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<PreferencesView>) => savePreferences(apiClient, storeId, input),
    onSuccess: view => queryClient.setQueryData(ContentKeys.preferences(storeId), view)
  })
}
