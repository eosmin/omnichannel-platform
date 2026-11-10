import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'

// The stock column of the catalog lives apart from the rest of the stock api: the list page needs only this, and the
// panel of a product (loaded on demand) needs the others.
const stockSummarySchema = z.object({
  data: z.array(
    z.object({
      productId: z.string(),
      trackInventory: z.boolean(),
      onHand: z.number().int(),
      reserved: z.number().int(),
      available: z.number().int(),
      lowStockThreshold: z.number().int().nullable(),
      isLow: z.boolean()
    })
  )
})
export type StockSummaryView = z.output<typeof stockSummarySchema>['data'][number]

// The stock of up to 100 products at once, one row each (the stock column of the catalog)
export function fetchStockSummary(
  client: ApiClient,
  storeId: string,
  productIds: readonly string[],
  signal?: AbortSignal
): Promise<StockSummaryView[]> {
  return client
    .request(
      `${ApiRoutes.inventory.summary}?${new URLSearchParams({ productIds: productIds.join(',') }).toString()}`,
      {
        schema: stockSummarySchema,
        storeId,
        signal
      }
    )
    .then(answer => answer.data)
}
