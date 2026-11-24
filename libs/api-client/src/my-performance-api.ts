import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'

// Apart from the rest of the analytics api: the inbox draws this one, and the dashboard (loaded on its own page) the other
// GET /analytics/my-performance: what the person who asks did today, for the widget of the inbox
export const myPerformanceSchema = z.object({
  dayStart: z.iso.datetime(),
  resolved: z.number().int(),
  open: z.number().int(),
  medianFirstResponseSeconds: z.number().nullable(),
  answered: z.number().int()
})
export type MyPerformanceView = z.output<typeof myPerformanceSchema>

export function fetchMyPerformance(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<MyPerformanceView> {
  return client.request(ApiRoutes.analytics.myPerformance, {
    schema: myPerformanceSchema,
    storeId,
    signal
  })
}
