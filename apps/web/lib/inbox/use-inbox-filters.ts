'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'

import type { ConversationFilters } from '@platform/api-client'

import { FILTER_PARAMS, filtersFromParams, paramsFromFilters } from './inbox-filters'

// The filters of the address, and the way to change them. The page stays where it is: a conversation
// that is open stays open while the list narrows.
export function useInboxFilters(): {
  filters: ConversationFilters
  search: string
  setFilters: (filters: ConversationFilters) => void
} {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const filters = useMemo(() => filtersFromParams(params), [params])
  const search = useMemo(() => {
    const query = paramsFromFilters(filters).toString()
    return query === '' ? '' : `?${query}`
  }, [filters])
  const setFilters = useCallback(
    (next: ConversationFilters) => {
      // Only the filters change: anything else in the address stays, and the list keeps its place
      const nextParams = new URLSearchParams(params)
      for (const key of FILTER_PARAMS) nextParams.delete(key)
      for (const [key, value] of paramsFromFilters(next)) nextParams.set(key, value)
      const query = nextParams.toString()
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false })
    },
    [params, pathname, router]
  )
  return { filters, search, setFilters }
}
