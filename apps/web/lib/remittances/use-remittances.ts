'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type CreateRemittanceInput,
  type RemittanceDetailView,
  type RemittancePageView,
  type PendingConnectionView,
  type CarrierConnectionView,
  confirmRemittance,
  createRemittance,
  discardRemittance,
  fetchAllCarrierConnections,
  fetchRemittance,
  fetchRemittancePending,
  fetchRemittances,
  QueryKeys,
  updateRemittanceLine,
  voidRemittance
} from '@platform/api-client'
import type {
  ConfirmRemittanceBody,
  RemittanceStatus,
  UpdateRemittanceLineBody
} from '@platform/core/domain'

import { apiClient } from '../api'
import { fetchPreferences } from '../settings/preferences-requests'

// The hooks of the remittance screens. Only those pages load this file.

export const REMITTANCES_PAGE = 25

export interface RemittanceListFilter {
  status: RemittanceStatus | null
  connectionId: string | null
}

export function useRemittances(
  storeId: string,
  filter: RemittanceListFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<RemittancePageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.remittances.list(storeId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchRemittances(
        apiClient,
        storeId,
        {
          cursor: pageParam,
          limit: REMITTANCES_PAGE,
          status: filter.status ?? undefined,
          connectionId: filter.connectionId ?? undefined
        },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

// What the carriers still owe, one row per connection; with one connection asked for, its shipments too (oldest first)
export function useRemittancePending(
  storeId: string,
  connectionId: string | null,
  enabled: boolean
): UseQueryResult<PendingConnectionView[]> {
  return useQuery({
    queryKey: QueryKeys.remittances.pending(storeId, connectionId),
    queryFn: ({ signal }) =>
      fetchRemittancePending(apiClient, storeId, connectionId ?? undefined, signal),
    enabled
  })
}

export function useRemittance(
  storeId: string,
  remittanceId: string,
  enabled: boolean
): UseQueryResult<RemittanceDetailView> {
  return useQuery({
    queryKey: QueryKeys.remittances.detail(storeId, remittanceId),
    queryFn: ({ signal }) => fetchRemittance(apiClient, storeId, remittanceId, signal),
    enabled
  })
}

// The connections of the store with what each can do: the same cache entry as Settings → Carriers
export function useRemittanceConnections(
  storeId: string,
  enabled: boolean
): UseQueryResult<CarrierConnectionView[]> {
  return useQuery({
    queryKey: QueryKeys.carriers.list(storeId),
    queryFn: ({ signal }) => fetchAllCarrierConnections(apiClient, storeId, signal),
    enabled,
    // The list is read with the permission of shipping: a person without it gets no carrier filter, not a retry
    retry: false
  })
}

// The days after which what a carrier owes counts as late. It lives in the preferences of the store, which a person with only
// the remittance permission may not read: then there is no threshold and no warning (never a guess)
export function useOverdueThreshold(storeId: string, enabled: boolean): number | null {
  const preferences = useQuery({
    queryKey: QueryKeys.preferences.store(storeId),
    queryFn: ({ signal }) => fetchPreferences(apiClient, storeId, signal),
    enabled,
    retry: false
  })
  return preferences.data?.remittances.overdueAfterDays ?? null
}

// The answer of a change is the remittance as it is now: it replaces the cached one, and everything that listed remittances,
// or what is still owed, is read again (a confirmation or a void moves shipments in and out of the pending list)
// A correction of a line moves no shipment, so it reads only the lists again (a draft's totals are in them); creating, confirming
// or voiding moves shipments in and out of the pending list too. The detail is never read again: the answer is it.
function useSettle(
  storeId: string,
  movesShipments: boolean
): (remittance: RemittanceDetailView) => void {
  const queryClient = useQueryClient()
  return remittance => {
    queryClient.setQueryData(QueryKeys.remittances.detail(storeId, remittance.id), remittance)
    void queryClient.invalidateQueries({
      queryKey: QueryKeys.remittances.all(storeId),
      predicate: query =>
        query.queryKey[2] !== 'detail' && (movesShipments || query.queryKey[2] !== 'pending')
    })
  }
}

export function useCreateRemittance(
  storeId: string
): UseMutationResult<RemittanceDetailView, Error, CreateRemittanceInput> {
  const settle = useSettle(storeId, true)
  return useMutation({
    mutationFn: input => createRemittance(apiClient, storeId, input),
    onSuccess: settle
  })
}

export function useDiscardRemittance(storeId: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: id => discardRemittance(apiClient, storeId, id),
    onSuccess: (_result, id) => {
      // The page of the discarded draft is still mounted until the router leaves it: its entry is not read again (a 404 would
      // flash), only the lists and the pending totals are
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.remittances.all(storeId),
        predicate: query => query.queryKey[2] !== 'detail'
      })
      queryClient.removeQueries({
        queryKey: QueryKeys.remittances.detail(storeId, id),
        type: 'inactive'
      })
    }
  })
}

export function useUpdateRemittanceLine(
  storeId: string,
  remittanceId: string
): UseMutationResult<
  RemittanceDetailView,
  Error,
  { lineId: string; body: UpdateRemittanceLineBody }
> {
  const settle = useSettle(storeId, false)
  return useMutation({
    mutationFn: ({ lineId, body }) =>
      updateRemittanceLine(apiClient, storeId, remittanceId, lineId, body),
    onSuccess: settle
  })
}

export function useConfirmRemittance(
  storeId: string,
  remittanceId: string
): UseMutationResult<RemittanceDetailView, Error, ConfirmRemittanceBody> {
  const settle = useSettle(storeId, true)
  return useMutation({
    mutationFn: input => confirmRemittance(apiClient, storeId, remittanceId, input),
    onSuccess: settle
  })
}

export function useVoidRemittance(
  storeId: string,
  remittanceId: string
): UseMutationResult<RemittanceDetailView, Error, string | null> {
  const settle = useSettle(storeId, true)
  return useMutation({
    mutationFn: reason =>
      voidRemittance(apiClient, storeId, remittanceId, reason === null ? {} : { reason }),
    onSuccess: settle
  })
}
