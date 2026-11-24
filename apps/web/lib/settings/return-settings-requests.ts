import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import { ShippingPayer } from '@platform/core/domain'

// Settings → Returns (TDD_17 §4.11, §4.14): who pays the way back of a return, and of a replacement, when a return does not
// say. The api takes only the keys that change (a PATCH), and a change never touches a return that exists.

const returnSettingsSchema = z.object({
  returnShippingPayer: z.enum(ShippingPayer)
})
export type ReturnSettingsView = z.output<typeof returnSettingsSchema>
export type ReturnSettingsInput = Partial<ReturnSettingsView>

export function fetchReturnSettings(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<ReturnSettingsView> {
  return client.request(ApiRoutes.settings.returns, {
    schema: returnSettingsSchema,
    storeId,
    signal
  })
}

export function saveReturnSettings(
  client: ApiClient,
  storeId: string,
  input: ReturnSettingsInput
): Promise<ReturnSettingsView> {
  return client.request(ApiRoutes.settings.returns, {
    method: 'PATCH',
    body: input,
    schema: returnSettingsSchema,
    storeId
  })
}
