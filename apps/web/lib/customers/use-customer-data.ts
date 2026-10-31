'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import { useCallback } from 'react'

import {
  type ConversationPageView,
  attachCustomerTag,
  createCustomerAddress,
  createCustomerNote,
  type CustomerAddressChanges,
  type CustomerAddressInput,
  type CustomerAddressView,
  type CustomerChanges,
  type CustomerIdentityInput,
  type CustomerIdentityView,
  type CustomerMergePreviewView,
  type CustomerDetailView,
  type CustomerListPageView,
  type CustomerNoteView,
  type CustomerTimelinePageView,
  deleteCustomerAddress,
  deleteCustomerNote,
  detachCustomerTag,
  fetchCustomer,
  fetchCustomerMergePreview,
  fetchCustomers,
  fetchCustomerConversations,
  fetchCustomerTimeline,
  linkCustomerIdentity,
  mergeCustomers,
  type MergeFieldChoices,
  QueryKeys,
  type TagView,
  unlinkCustomerIdentity,
  unmergeCustomers,
  updateCustomer,
  updateCustomerAddress
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

// The customers page: one page per cursor, narrowed by the search text. The text is trimmed by the
// caller; an empty one lists everyone.
export function useCustomerList(
  storeId: string,
  q: string,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<CustomerListPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.customers.list(storeId, q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchCustomers(
        apiClient,
        storeId,
        { q: q === '' ? undefined : q, cursor: pageParam },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    // The rows stay while the next search loads, so typing does not blink the table
    placeholderData: keepPreviousData,
    enabled
  })
}

export interface CustomerEdits {
  update: UseMutationResult<CustomerDetailView, Error, CustomerChanges>
  addNote: UseMutationResult<CustomerNoteView, Error, string>
  removeNote: UseMutationResult<void, Error, string>
  addAddress: UseMutationResult<CustomerAddressView, Error, CustomerAddressInput>
  editAddress: UseMutationResult<
    CustomerAddressView,
    Error,
    { addressId: string; changes: CustomerAddressChanges }
  >
  removeAddress: UseMutationResult<void, Error, string>
  addTag: UseMutationResult<TagView[], Error, string>
  removeTag: UseMutationResult<void, Error, string>
}

// What an agent changes in the profile. Each change makes the customer, the list and the activity
// stale; the name also shows in the inbox, so the conversations are read again after a rename.
export function useCustomerEdits(storeId: string, customerId: string): CustomerEdits {
  const queryClient = useQueryClient()
  const refresh = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: QueryKeys.customers.all(storeId) })
  }, [queryClient, storeId])
  const refreshWithInbox = useCallback(async (): Promise<void> => {
    await Promise.all([
      refresh(),
      queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) })
    ])
  }, [queryClient, storeId, refresh])

  const update = useMutation({
    mutationFn: (changes: CustomerChanges) =>
      updateCustomer(apiClient, storeId, customerId, changes),
    onSuccess: refreshWithInbox
  })
  const addNote = useMutation({
    mutationFn: (content: string) => createCustomerNote(apiClient, storeId, customerId, content),
    onSuccess: refresh
  })
  const removeNote = useMutation({
    mutationFn: (noteId: string) => deleteCustomerNote(apiClient, storeId, customerId, noteId),
    onSuccess: refresh
  })
  const addAddress = useMutation({
    mutationFn: (address: CustomerAddressInput) =>
      createCustomerAddress(apiClient, storeId, customerId, address),
    onSuccess: refresh
  })
  const editAddress = useMutation({
    mutationFn: ({ addressId, changes }: { addressId: string; changes: CustomerAddressChanges }) =>
      updateCustomerAddress(apiClient, storeId, customerId, addressId, changes),
    onSuccess: refresh
  })
  const removeAddress = useMutation({
    mutationFn: (addressId: string) =>
      deleteCustomerAddress(apiClient, storeId, customerId, addressId),
    onSuccess: refresh
  })
  const addTag = useMutation({
    mutationFn: (tagId: string) => attachCustomerTag(apiClient, storeId, customerId, tagId),
    onSuccess: refresh
  })
  const removeTag = useMutation({
    mutationFn: (tagId: string) => detachCustomerTag(apiClient, storeId, customerId, tagId),
    onSuccess: refresh
  })

  return { update, addNote, removeNote, addAddress, editAddress, removeAddress, addTag, removeTag }
}

// What the merge would do, read when the user has picked the duplicate. A merge that is under way
// must not change what the user confirmed, so the preview is not read again on its own.
export function useMergePreview(
  storeId: string,
  survivorId: string,
  absorbedId: string | null
): UseQueryResult<CustomerMergePreviewView> {
  return useQuery({
    queryKey: QueryKeys.customers.mergePreview(storeId, survivorId, absorbedId ?? ''),
    queryFn: ({ signal }) =>
      fetchCustomerMergePreview(apiClient, storeId, survivorId, absorbedId ?? '', signal),
    enabled: absorbedId !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false
  })
}

// A merge or a link moves conversations between customers, so the customers, their activity and the
// inbox are all stale after it
function useRefreshCustomersAndInbox(storeId: string): () => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: QueryKeys.customers.all(storeId) }),
      queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) })
    ])
  }, [queryClient, storeId])
}

export interface CustomerMerges {
  merge: UseMutationResult<
    CustomerDetailView,
    Error,
    { absorbedId: string; fieldChoices: MergeFieldChoices }
  >
  unmerge: UseMutationResult<CustomerDetailView, Error, string>
}

// A merge moves conversations, notes, addresses, tags and identities, so the customers, their activity
// and the inbox are all stale after it, and after undoing it.
export function useCustomerMerges(storeId: string, customerId: string): CustomerMerges {
  const refresh = useRefreshCustomersAndInbox(storeId)
  const merge = useMutation({
    mutationFn: ({
      absorbedId,
      fieldChoices
    }: {
      absorbedId: string
      fieldChoices: MergeFieldChoices
    }) => mergeCustomers(apiClient, storeId, customerId, absorbedId, fieldChoices),
    onSuccess: refresh
  })
  const unmerge = useMutation({
    mutationFn: (mergeId: string) => unmergeCustomers(apiClient, storeId, customerId, mergeId),
    onSuccess: refresh
  })
  return { merge, unmerge }
}

export interface CustomerIdentityEdits {
  link: UseMutationResult<CustomerIdentityView, Error, CustomerIdentityInput>
  unlink: UseMutationResult<void, Error, string>
}

// Linking a handle changes the customer, the list (its channels) and who a conversation belongs to
export function useCustomerIdentityEdits(
  storeId: string,
  customerId: string
): CustomerIdentityEdits {
  const refresh = useRefreshCustomersAndInbox(storeId)
  const link = useMutation({
    mutationFn: (identity: CustomerIdentityInput) =>
      linkCustomerIdentity(apiClient, storeId, customerId, identity),
    onSuccess: refresh
  })
  const unlink = useMutation({
    mutationFn: (identityId: string) =>
      unlinkCustomerIdentity(apiClient, storeId, customerId, identityId),
    onSuccess: refresh
  })
  return { link, unlink }
}
