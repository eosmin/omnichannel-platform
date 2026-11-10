'use client'

import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'

import { fetchStockSummary, QueryKeys, type StockSummaryView } from '@platform/api-client'
import { PaginationLimits } from '@platform/core/domain'

import { apiClient } from '../api'

// The api answers the stock of 100 products at most in one request
const SUMMARY_CHUNK = PaginationLimits.MAX

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let from = 0; from < items.length; from += size) chunks.push(items.slice(from, from + size))
  return chunks
}

// The stock column of the catalog: the products shown, asked 100 at a time, as a map by product id. Nothing is asked
// when there is nothing to show or the member may not read stock.
export function useStockSummaries(
  storeId: string,
  productIds: readonly string[],
  enabled: boolean
): { byProduct: ReadonlyMap<string, StockSummaryView>; isError: boolean } {
  const chunks = useMemo(() => chunked(productIds, SUMMARY_CHUNK), [productIds])
  const results = useQueries({
    queries: chunks.map(ids => ({
      queryKey: QueryKeys.inventory.summary(storeId, ids),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchStockSummary(apiClient, storeId, ids, signal),
      enabled: enabled && ids.length > 0,
      // What was shown stays while a new page of products is asked
      staleTime: 15_000
    }))
  })
  // Built on every render: it is a handful of rows, and the results array is new each time anyway
  const byProduct = new Map<string, StockSummaryView>()
  for (const result of results) {
    for (const row of result.data ?? []) byProduct.set(row.productId, row)
  }
  return { byProduct, isError: results.some(result => result.isError) }
}
