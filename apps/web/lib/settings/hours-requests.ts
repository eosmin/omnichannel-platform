import { z } from 'zod'

import { type ApiClient, ApiError } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import { BUSINESS_HOURS_TIMEZONE_METADATA_KEY } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

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

// What the page starts from: the saved hours (null for a store that has none) and the time zone the
// store works in. A store with no schedule answers 404 with its zone, which is how a role without
// CONVERSATIONS_VIEW (it cannot read the inbox behavior) learns it. Any other failure is thrown, so a
// network problem is never read as "no schedule yet".
export interface BusinessHoursState {
  hours: BusinessHoursView | null
  storeTimezone: string | null
}

export async function readBusinessHours(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<BusinessHoursState> {
  try {
    const hours = await fetchBusinessHours(client, storeId, signal)
    return { hours, storeTimezone: hours.timezone }
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== HttpStatusCodes.NOT_FOUND) throw error
    const zone = error.metadata[BUSINESS_HOURS_TIMEZONE_METADATA_KEY]
    return { hours: null, storeTimezone: typeof zone === 'string' ? zone : null }
  }
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
