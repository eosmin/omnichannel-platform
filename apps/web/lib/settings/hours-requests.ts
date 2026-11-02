import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Settings → Business hours: the weekly schedule of a store and the snippet sent when nobody answers.

const rangeSchema = z.object({ from: z.string(), to: z.string() })
export type HoursRange = z.output<typeof rangeSchema>

const scheduleSchema = z.object({
  mon: z.array(rangeSchema),
  tue: z.array(rangeSchema),
  wed: z.array(rangeSchema),
  thu: z.array(rangeSchema),
  fri: z.array(rangeSchema),
  sat: z.array(rangeSchema),
  sun: z.array(rangeSchema)
})
export type WeekSchedule = z.output<typeof scheduleSchema>

const hoursSchema = z.object({
  timezone: z.string(),
  schedule: scheduleSchema,
  awayMessageSnippetId: z.string().nullable()
})
export type BusinessHoursView = z.output<typeof hoursSchema>

// A store that never saved a schedule has none (the api answers 404), which is not the same as one
// that is always closed: the page tells the two apart
export function fetchBusinessHours(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<BusinessHoursView> {
  return client.request(ApiRoutes.settings.businessHours, { schema: hoursSchema, storeId, signal })
}

// The whole week is replaced
export function saveBusinessHours(
  client: ApiClient,
  storeId: string,
  hours: BusinessHoursView
): Promise<BusinessHoursView> {
  return client.request(ApiRoutes.settings.businessHours, {
    method: 'PUT',
    body: hours,
    schema: hoursSchema,
    storeId
  })
}
