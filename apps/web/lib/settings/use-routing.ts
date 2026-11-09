'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'
import { useCallback } from 'react'

import {
  ApiError,
  type ChannelDirectoryEntryView,
  fetchChannelDirectory,
  fetchMemberDirectory,
  fetchSnippets,
  fetchTags,
  type MemberDirectoryEntryView,
  QueryKeys,
  type SnippetView,
  type TagView
} from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

import { apiClient } from '../api'
import { usePluginLabel } from '../plugin-label'

import { type BusinessHoursView, fetchBusinessHours, saveBusinessHours } from './hours-requests'
import { RoutingKeys } from './routing-keys'
import {
  createRule,
  deleteRule,
  fetchRules,
  reorderRules,
  type RuleInput,
  type RuleView,
  updateRule
} from './routing-requests'

// The hooks of Settings → Routing and Business hours. Only those pages load this file.

export function useRules(storeId: string): UseQueryResult<RuleView[]> {
  return useQuery({
    queryKey: RoutingKeys.rules(storeId),
    queryFn: ({ signal }) => fetchRules(apiClient, storeId, signal)
  })
}

export function useCreateRule(storeId: string): UseMutationResult<RuleView, Error, RuleInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: RuleInput) => createRule(apiClient, storeId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RoutingKeys.rules(storeId) })
  })
}

export function useUpdateRule(
  storeId: string
): UseMutationResult<RuleView, Error, { ruleId: string; input: Partial<RuleInput> }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ ruleId, input }) => updateRule(apiClient, storeId, ruleId, input),
    // Settled, not only success: a rule that was deleted by someone else is gone from the list
    onSettled: () => queryClient.invalidateQueries({ queryKey: RoutingKeys.rules(storeId) })
  })
}

export function useDeleteRule(storeId: string): UseMutationResult<undefined, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ruleId: string) => deleteRule(apiClient, storeId, ruleId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: RoutingKeys.rules(storeId) })
  })
}

// The list answers with the rules in the new order. If another person added or removed a rule in the
// meantime the api refuses the list, and the page reads the rules again to show the real order.
export function useReorderRules(storeId: string): UseMutationResult<RuleView[], Error, string[]> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ruleIds: string[]) => reorderRules(apiClient, storeId, ruleIds),
    // A read that started before the change must not land after it and bring the old order back
    onMutate: () => queryClient.cancelQueries({ queryKey: RoutingKeys.rules(storeId) }),
    onSuccess: rules => queryClient.setQueryData(RoutingKeys.rules(storeId), rules),
    onError: () => queryClient.invalidateQueries({ queryKey: RoutingKeys.rules(storeId) })
  })
}

// The people, tags and snippets that a rule or the schedule points at. Same keys as the inbox, so a
// list already read there is not asked for again; each is enabled only for who may read it.
export function useMemberChoices(
  storeId: string,
  enabled: boolean
): UseQueryResult<MemberDirectoryEntryView[]> {
  return useQuery({
    queryKey: QueryKeys.members.directory(storeId),
    queryFn: ({ signal }) => fetchMemberDirectory(apiClient, storeId, signal),
    enabled
  })
}

// The channels of the store, to pick the ones a rule applies to. The directory is open to who may see
// conversations, so it is asked for only by them.
export function useChannelChoices(
  storeId: string,
  enabled: boolean
): UseQueryResult<ChannelDirectoryEntryView[]> {
  const label = usePluginLabel()
  return useQuery({
    queryKey: QueryKeys.channels.directory(storeId),
    queryFn: ({ signal }) => fetchChannelDirectory(apiClient, storeId, signal),
    select: useCallback(
      (entries: ChannelDirectoryEntryView[]) =>
        entries.map(entry => ({ ...entry, pluginName: label(entry.descriptor, entry.pluginName) })),
      [label]
    ),
    enabled
  })
}

export function useTagChoices(storeId: string, enabled: boolean): UseQueryResult<TagView[]> {
  return useQuery({
    queryKey: QueryKeys.tags.all(storeId),
    queryFn: ({ signal }) => fetchTags(apiClient, storeId, signal),
    enabled
  })
}

export function useSnippetChoices(
  storeId: string,
  enabled: boolean
): UseQueryResult<SnippetView[]> {
  return useQuery({
    queryKey: QueryKeys.snippets.all(storeId),
    queryFn: ({ signal }) => fetchSnippets(apiClient, storeId, signal),
    enabled
  })
}

// null is a store that never saved a schedule (404): the page offers to make one. Any other failure is
// an error, so a network problem is never read as "no schedule yet".
export function useBusinessHours(storeId: string): UseQueryResult<BusinessHoursView | null> {
  return useQuery({
    queryKey: RoutingKeys.hours(storeId),
    queryFn: async ({ signal }) => {
      try {
        return await fetchBusinessHours(apiClient, storeId, signal)
      } catch (error) {
        if (error instanceof ApiError && error.status === HttpStatusCodes.NOT_FOUND) return null
        throw error
      }
    },
    retry: (count, error) =>
      !(error instanceof ApiError && error.status < HttpStatusCodes.INTERNAL_SERVER_ERROR) &&
      count < 2
  })
}

export function useSaveBusinessHours(
  storeId: string
): UseMutationResult<BusinessHoursView, Error, BusinessHoursView> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (hours: BusinessHoursView) => saveBusinessHours(apiClient, storeId, hours),
    onSuccess: hours => {
      queryClient.setQueryData(RoutingKeys.hours(storeId), hours)
      // The zone of the hours is the one the store shows every hour in
      void queryClient.invalidateQueries({ queryKey: QueryKeys.inboxBehavior.store(storeId) })
    }
  })
}
