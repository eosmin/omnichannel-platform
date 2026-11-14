'use client'

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'

import {
  type CustomerSearchPageView,
  type GlobalSearchView,
  type MessageSearchPageView,
  type OrderSearchPageView,
  type ProductSearchPageView,
  QueryKeys,
  searchCatalog,
  searchCustomers,
  searchGlobal,
  searchMessages,
  searchOrders
} from '@platform/api-client'
import { SearchEntities, type SearchEntity } from '@platform/core/domain'

import { apiClient } from '../api'

const COUNTED_SEARCH = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false
} as const

// The palette and the "all" tab: a few hits of each kind. `text` is already the debounced, ready text (or null: nothing
// to ask yet); the previous answer stays on the screen while the next one loads, so the list does not blink. The palette
// asks `passive`: it searches as the person types, which the report of what was searched does not count.
export function useGlobalSearch(
  storeId: string,
  text: string | null,
  passive = false
): UseQueryResult<GlobalSearchView> {
  return useQuery({
    queryKey: QueryKeys.search.global(storeId, text ?? '', passive),
    queryFn: ({ signal }) => searchGlobal(apiClient, storeId, text ?? '', signal, { passive }),
    enabled: text !== null,
    placeholderData: keepPreviousData,
    // A search that counts is made once for each text: a refocused window, a reconnect or a return to the tab must not
    // make it again, or the report would count one search many times. The palette's passive one may refresh freely.
    ...(passive ? { staleTime: 0 } : COUNTED_SEARCH)
  })
}

export type ScopedSearchView =
  | { scope: typeof SearchEntities.MESSAGES; page: MessageSearchPageView }
  | { scope: typeof SearchEntities.CUSTOMERS; page: CustomerSearchPageView }
  | { scope: typeof SearchEntities.ORDERS; page: OrderSearchPageView }
  | { scope: typeof SearchEntities.PRODUCTS; page: ProductSearchPageView }

// One tab of the results page: the route of one kind of thing, with its own page of hits
export function useScopedSearch(
  storeId: string,
  scope: SearchEntity,
  text: string | null
): UseQueryResult<ScopedSearchView> {
  return useQuery({
    queryKey: QueryKeys.search.scoped(storeId, scope, text ?? ''),
    queryFn: async ({ signal }): Promise<ScopedSearchView> => {
      const q = text ?? ''
      switch (scope) {
        case SearchEntities.MESSAGES:
          return { scope, page: await searchMessages(apiClient, storeId, { q }, signal) }
        case SearchEntities.CUSTOMERS:
          return { scope, page: await searchCustomers(apiClient, storeId, { q }, signal) }
        case SearchEntities.ORDERS:
          return { scope, page: await searchOrders(apiClient, storeId, { q }, signal) }
        case SearchEntities.PRODUCTS:
          return { scope, page: await searchCatalog(apiClient, storeId, { q }, signal) }
      }
    },
    enabled: text !== null,
    ...COUNTED_SEARCH,
    // The previous answer stays while the next loads, but only for the same kind: the hits of another tab under this
    // one would be the wrong kind of result
    placeholderData: previous => (previous?.scope === scope ? previous : undefined)
  })
}
