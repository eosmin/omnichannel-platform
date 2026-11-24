import { z } from 'zod'

import {
  MetricAggregations,
  type MetricDimensions,
  type RolledUpMetric,
  type TimeGranularityType
} from '@platform/core/analytics'
import { ApiRoutesAnalytics } from '@platform/core/api'
import { SearchTrackedScopes } from '@platform/core/domain'

import type { ApiClient } from './api-client'

const pointSchema = z.object({ timestamp: z.iso.datetime(), value: z.number(), count: z.number() })

// GET /analytics/metrics: the series of one metric from the rollup tables. A range is [from, to); a day is a UTC day.
export const metricsResultSchema = z.object({
  metric: z.string(),
  granularity: z.string(),
  dimension: z.string(),
  // How a coarser point is put together: a time of a week or a month is the mean of its days' medians, weighted
  aggregation: z.enum([
    MetricAggregations.SUM,
    MetricAggregations.WEIGHTED_MEAN,
    MetricAggregations.LAST
  ]),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  series: z.array(
    z.object({
      dimensionId: z.string(),
      points: z.array(pointSchema),
      summary: z.object({ value: z.number(), count: z.number() })
    })
  )
})
export type MetricsResultView = z.output<typeof metricsResultSchema>
export type MetricSeriesView = MetricsResultView['series'][number]

export interface MetricsRequest {
  metric: RolledUpMetric
  granularity: TimeGranularityType
  from: string
  to: string
  // A metric that has a breakdown is read by it
  dimension?: (typeof MetricDimensions)[keyof typeof MetricDimensions]
}

export function fetchMetrics(
  client: ApiClient,
  storeId: string,
  request: MetricsRequest,
  signal?: AbortSignal
): Promise<MetricsResultView> {
  const params = new URLSearchParams({
    metric: request.metric,
    granularity: request.granularity,
    from: request.from,
    to: request.to
  })
  if (request.dimension !== undefined && request.dimension !== '') {
    params.set('dimension', request.dimension)
  }
  return client.request(`${ApiRoutesAnalytics.metrics}?${params.toString()}`, {
    schema: metricsResultSchema,
    storeId,
    signal
  })
}

// GET /analytics/search: what was searched in the store (Step 5.2 PR C3, TDD_08 §5.6)
export const searchReportSchema = z.object({
  days: z.number(),
  scopes: z.array(
    z.object({
      scope: z.enum(Object.values(SearchTrackedScopes)),
      searches: z.number(),
      zeroResults: z.number(),
      clicks: z.number()
    })
  ),
  zeroResultQueries: z.array(z.object({ query: z.string(), occurrences: z.number() }))
})
export type SearchReportView = z.output<typeof searchReportSchema>

export function fetchSearchReport(
  client: ApiClient,
  storeId: string,
  days: number,
  signal?: AbortSignal
): Promise<SearchReportView> {
  return client.request(`${ApiRoutesAnalytics.search}?days=${days}`, {
    schema: searchReportSchema,
    storeId,
    signal
  })
}
