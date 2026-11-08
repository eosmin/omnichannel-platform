'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'

import type { ConversationFilters } from '@platform/api-client'

import {
  FILTER_PARAMS,
  filtersFromParams,
  onlyDraftsFromParams,
  paramsFromFilters,
  searchOf,
  withOnlyDrafts
} from './inbox-filters'

// The filters of the address, and the way to change them. The page stays where it is: a conversation
// that is open stays open while the list narrows.
export function useInboxFilters(): {
  filters: ConversationFilters
  // The view of the conversations that have a draft (the drafts are in this tab, so it is not a filter of the api)
  onlyDrafts: boolean
  search: string
  setFilters: (filters: ConversationFilters) => void
  setOnlyDrafts: (onlyDrafts: boolean) => void
  // Filters and draft view at once: two writes of the address from one reading would undo each other
  clearAll: () => void
} {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const filters = useMemo(() => filtersFromParams(params), [params])
  const onlyDrafts = useMemo(() => onlyDraftsFromParams(params), [params])
  const search = useMemo(() => searchOf(filters, onlyDrafts), [filters, onlyDrafts])
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
  const setOnlyDrafts = useCallback(
    (next: boolean) => {
      const query = withOnlyDrafts(params, next).toString()
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false })
    },
    [params, pathname, router]
  )
  const clearAll = useCallback(() => {
    const nextParams = withOnlyDrafts(params, false)
    for (const key of FILTER_PARAMS) nextParams.delete(key)
    const query = nextParams.toString()
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false })
  }, [params, pathname, router])
  return { filters, onlyDrafts, search, setFilters, setOnlyDrafts, clearAll }
}
