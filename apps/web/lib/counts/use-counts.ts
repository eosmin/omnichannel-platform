'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  applyCount,
  cancelCount,
  type CountDetailView,
  type CountLineEntry,
  type CountPageView,
  type CountView,
  type CountWarehouseOption,
  type CreateCountInput,
  createCount,
  fetchAllCountLines,
  fetchCounts,
  fetchCountWarehouses,
  QueryKeys,
  reopenCount,
  startCount,
  submitCount,
  updateCountLines
} from '@platform/api-client'
import type { CountStatus } from '@platform/core/domain'

import { apiClient } from '../api'

// The hooks of the count screens. Only those pages load this file.

export const COUNTS_PAGE = 25

export function useCounts(
  storeId: string,
  status: CountStatus | null
): UseInfiniteQueryResult<InfiniteData<CountPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.counts.list(storeId, status),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchCounts(
        apiClient,
        storeId,
        { cursor: pageParam, limit: COUNTS_PAGE, status: status ?? undefined },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined)
  })
}

// The active warehouses of the organization, for a new count to name one
export function useCountWarehouses(
  storeId: string,
  enabled: boolean
): UseQueryResult<CountWarehouseOption[]> {
  return useQuery({
    queryKey: QueryKeys.counts.warehouses(storeId),
    queryFn: ({ signal }) => fetchCountWarehouses(apiClient, storeId, signal),
    enabled
  })
}

// The whole sheet of a count. It is not read again when the window gets the focus: what is typed on the sheet lives on
// the page and in the draft, and a read of up to 2 000 lines is not for every switch of tab.
export function useCountSheet(storeId: string, countId: string): UseQueryResult<CountDetailView> {
  return useQuery({
    queryKey: QueryKeys.counts.detail(storeId, countId),
    queryFn: ({ signal }) => fetchAllCountLines(apiClient, storeId, countId, undefined, signal),
    refetchOnWindowFocus: false
  })
}

// A change of a count makes the list of every store and the sheets stale: a count is the organization's
function useRefreshCounts(): () => Promise<void> {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: QueryKeys.counts.root })
}

export function useCreateCount(
  storeId: string
): UseMutationResult<CountView, Error, CreateCountInput> {
  const refresh = useRefreshCounts()
  return useMutation({
    mutationFn: (input: CreateCountInput) => createCount(apiClient, storeId, input),
    onSuccess: () => void refresh()
  })
}

export const CountActions = {
  START: 'start',
  SUBMIT: 'submit',
  REOPEN: 'reopen',
  APPLY: 'apply',
  CANCEL: 'cancel'
} as const
export type CountAction = (typeof CountActions)[keyof typeof CountActions]

const ACTION_CALLS = {
  [CountActions.START]: startCount,
  [CountActions.SUBMIT]: submitCount,
  [CountActions.REOPEN]: reopenCount,
  [CountActions.APPLY]: applyCount,
  [CountActions.CANCEL]: cancelCount
} as const

// A change of state of one count. The stock screens are stale after an apply: it wrote movements.
export function useCountAction(
  storeId: string,
  countId: string
): UseMutationResult<CountView, Error, CountAction> {
  const queryClient = useQueryClient()
  const refresh = useRefreshCounts()
  return useMutation({
    mutationFn: (action: CountAction) => ACTION_CALLS[action](apiClient, storeId, countId),
    // The sheet is read again before the screen says the new state, so it never shows a state with the old lines
    onSuccess: async (_view, action) => {
      await refresh()
      if (action === CountActions.APPLY) {
        void queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.root })
      }
    }
  })
}

export function useSaveCountLines(
  storeId: string,
  countId: string
): UseMutationResult<CountView, Error, readonly CountLineEntry[]> {
  return useMutation({
    mutationFn: (lines: readonly CountLineEntry[]) =>
      updateCountLines(apiClient, storeId, countId, lines)
  })
}
