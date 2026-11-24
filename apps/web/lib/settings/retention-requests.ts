import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Settings → Data retention: the four windows, in days, after which the nightly run deletes what a store keeps. Kept with
// the page and not in `@platform/api-client`, whose barrel the inbox loads whole.

const retentionSchema = z.object({
  conversationDays: z.number().int(),
  mediaDays: z.number().int(),
  analyticsDays: z.number().int(),
  notificationDays: z.number().int()
})
export type RetentionView = z.output<typeof retentionSchema>

// The api takes the four at once: a save is the whole page
export type RetentionInput = RetentionView

export function fetchRetention(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<RetentionView> {
  return client.request(ApiRoutes.settings.retention, {
    schema: retentionSchema,
    storeId,
    signal
  })
}

export function saveRetention(
  client: ApiClient,
  storeId: string,
  input: RetentionInput
): Promise<RetentionView> {
  return client.request(ApiRoutes.settings.retention, {
    method: 'PUT',
    body: input,
    schema: retentionSchema,
    storeId
  })
}
