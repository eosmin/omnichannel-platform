import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Settings → Inventory (TDD_16 §4.10): the three switches of the store that the stock rules read. The api
// takes only the keys that change (a PATCH), and a null threshold clears it.

const inventorySettingsSchema = z.object({
  allowNegativeStock: z.boolean(),
  allowSplitFulfillment: z.boolean(),
  defaultLowStockThreshold: z.number().int().nullable()
})
export type InventorySettingsView = z.output<typeof inventorySettingsSchema>
export type InventorySettingsInput = Partial<InventorySettingsView>

export function fetchInventorySettings(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<InventorySettingsView> {
  return client.request(ApiRoutes.settings.inventory, {
    schema: inventorySettingsSchema,
    storeId,
    signal
  })
}

export function saveInventorySettings(
  client: ApiClient,
  storeId: string,
  input: InventorySettingsInput
): Promise<InventorySettingsView> {
  return client.request(ApiRoutes.settings.inventory, {
    method: 'PATCH',
    body: input,
    schema: inventorySettingsSchema,
    storeId
  })
}
