import { z } from 'zod'

import {
  AnalyticsFileFormats,
  analyticsExportFiltersSchema,
  ReportMetrics
} from '@platform/core/analytics'

// The query of `GET /analytics/export`: the metrics are a comma-separated list (a query string has no arrays), and the rest is
// what the row of the export keeps, checked by the same schema the worker reads it back with
export const analyticsExportQuerySchema = z
  .strictObject({
    metrics: z.string().min(1).max(ReportMetrics.join(',').length),
    from: z.string(),
    to: z.string(),
    format: z.enum(AnalyticsFileFormats)
  })
  .transform(({ format, metrics, ...period }) => ({
    format,
    filters: { metrics: metrics.split(','), ...period }
  }))
  .pipe(z.object({ format: z.enum(AnalyticsFileFormats), filters: analyticsExportFiltersSchema }))
export type AnalyticsExportQuery = z.output<typeof analyticsExportQuerySchema>
