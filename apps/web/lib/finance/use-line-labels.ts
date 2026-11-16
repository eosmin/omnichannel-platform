'use client'

import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'

import { fetchProduct, type PurchaseOrderLineView, QueryKeys } from '@platform/api-client'

import { apiClient } from '../api'

// The name of what a line buys, by its product and variant ids (the order carries only ids). A product the person cannot read from this
// store (another store's) keeps a short form of its id, never an empty cell. The products are the catalog's own cache entries.
export function useLineLabels(
  _screenStoreId: string,
  lines: readonly Pick<PurchaseOrderLineView, 'id' | 'storeId' | 'productId' | 'variantId'>[]
): ReadonlyMap<string, string> {
  // A line names the store of its product: that is the store the product is read through, not the one of the screen
  const products0 = useMemo(
    () => [
      ...new Map(lines.map(line => [`${line.storeId}:${line.productId}`, line] as const)).values()
    ],
    [lines]
  )
  const productIds = useMemo(
    () => products0.map(line => `${line.storeId}:${line.productId}`),
    [products0]
  )
  const products = useQueries({
    queries: products0.map(line => ({
      queryKey: QueryKeys.products.byId(line.storeId, line.productId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchProduct(apiClient, line.storeId, line.productId, signal),
      staleTime: 60_000,
      retry: false
    })),
    // The data only, in the order of the ids: the result keeps its identity while the data do not change
    combine: results => results.map(result => result.data)
  })
  return useMemo(() => {
    const byProduct = new Map(
      productIds.flatMap((productId, index) => {
        const data = products[index]
        return data === undefined ? [] : [[productId, data] as const]
      })
    )
    return new Map(
      lines.map(line => {
        const product = byProduct.get(`${line.storeId}:${line.productId}`)
        const variant = product?.variants.find(item => item.id === line.variantId)
        const name = product?.name ?? line.productId.slice(0, 8)
        return [line.id, variant === undefined ? name : `${name} · ${variant.name}`] as const
      })
    )
  }, [lines, productIds, products])
}
