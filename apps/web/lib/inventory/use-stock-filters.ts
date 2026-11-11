'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'

import {
  STOCK_PARAMS,
  type StockListState,
  stockParamsFromState,
  stockStateFromParams
} from './stock-filters'

// The filters and the sort of the address, and the way to change them. The page stays where it is and the history keeps
// one entry: narrowing a list is not a place to come back to.
export function useStockFilters(): {
  state: StockListState
  setState: (patch: Partial<StockListState>) => void
} {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const state = useMemo(() => stockStateFromParams(params), [params])
  const setState = useCallback(
    (patch: Partial<StockListState>) => {
      // The address as it is now, not as it was at the last render: two changes in a row (the search that settles and a
      // filter ticked) do not undo each other. Only what the page owns changes: anything else in the address stays.
      const current = new URLSearchParams(window.location.search)
      const next = { ...stockStateFromParams(current), ...patch }
      for (const key of STOCK_PARAMS) current.delete(key)
      for (const [key, value] of stockParamsFromState(next)) current.set(key, value)
      const query = current.toString()
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false })
    },
    [pathname, router]
  )
  return { state, setState }
}
