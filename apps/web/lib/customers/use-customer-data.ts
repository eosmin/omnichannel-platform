'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useQuery,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type ConversationPageView,
  type CustomerDetailView,
  type CustomerTimelinePageView,
  fetchCustomer,
  fetchCustomerConversations,
  fetchCustomerTimeline,
  QueryKeys
} from '@platform/api-client'
import { PaginationLimits, type CustomerTimelineType } from '@platform/core/domain'

import { apiClient } from '../api'

// `customerId` is null while the conversation that names it is still loading: nothing is read then
export function useCustomer(
  storeId: string,
  customerId: string | null
): UseQueryResult<CustomerDetailView> {
  return useQuery({
    queryKey: QueryKeys.customers.byId(storeId, customerId ?? ''),
    queryFn: ({ signal }) => fetchCustomer(apiClient, storeId, customerId ?? '', signal),
    enabled: customerId !== null
  })
}

export function useCustomerTimeline(
  storeId: string,
  customerId: string,
  type: CustomerTimelineType | undefined
): UseInfiniteQueryResult<InfiniteData<CustomerTimelinePageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.customers.timeline(storeId, customerId, type ?? 'all'),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchCustomerTimeline(apiClient, storeId, customerId, type, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined)
  })
}

// One page, the biggest the server gives: the profile shows the count it holds. `enabled` is false for
// a viewer without CONVERSATIONS_VIEW, whom the route refuses.
export function useCustomerConversations(
  storeId: string,
  customerId: string,
  enabled: boolean
): UseQueryResult<ConversationPageView> {
  return useQuery({
    queryKey: QueryKeys.customers.conversations(storeId, customerId),
    queryFn: ({ signal }) =>
      fetchCustomerConversations(apiClient, storeId, customerId, PaginationLimits.MAX, signal),
    enabled
  })
}
