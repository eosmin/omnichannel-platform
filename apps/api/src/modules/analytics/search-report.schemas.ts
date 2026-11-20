import { z } from 'zod'

import { SearchReportConfig, queryIntSchema } from '@platform/core/domain'

// How far back the report of what was searched looks: whole days up to the longest the dashboard may ask for
export const searchReportQuerySchema = z.strictObject({
  days: queryIntSchema(1, SearchReportConfig.MAX_DAYS).default(SearchReportConfig.DEFAULT_DAYS)
})
export type SearchReportQuery = z.infer<typeof searchReportQuerySchema>
