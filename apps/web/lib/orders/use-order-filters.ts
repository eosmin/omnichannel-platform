'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'

import {
  ORDER_PARAMS,
  type OrderListState,
  paramsFromState,
  stateFromParams
} from './order-filters'

// The filters and the sort of the address, and the way to change them. The page stays where it is and the history keeps
// one entry: narrowing a list is not a place to come back to.
export function useOrderFilters(): {
  state: OrderListState
  setState: (state: OrderListState) => void
} {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const state = useMemo(() => stateFromParams(params), [params])
  const setState = useCallback(
    (next: OrderListState) => {
      // Only what the page owns changes: anything else in the address stays
      const nextParams = new URLSearchParams(params)
      for (const key of ORDER_PARAMS) nextParams.delete(key)
      for (const [key, value] of paramsFromState(next)) nextParams.set(key, value)
      const query = nextParams.toString()
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false })
    },
    [params, pathname, router]
  )
  return { state, setState }
}
