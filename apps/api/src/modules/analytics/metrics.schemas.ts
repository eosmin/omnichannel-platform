import { z } from 'zod'

import {
  MetricDimensions,
  MetricDimensionsOf,
  MetricQueryLimits,
  RolledUpMetrics,
  type RolledUpMetric,
  TimeGranularity
} from '@platform/core/analytics'

const DAY_MS = 86_400_000

// The refinements also run when a date was refused, and then there is no span to judge: that refusal is already the answer
const spanOf = (query: { from: unknown; to: unknown }): number | null =>
  query.from instanceof Date && query.to instanceof Date
    ? query.to.getTime() - query.from.getTime()
    : null

const MIN_DATE = new Date(MetricQueryLimits.MIN_DATE)
const MAX_DATE = new Date(MetricQueryLimits.MAX_DATE)
// A date that was refused is not judged again here: that refusal is already the answer
const inBounds = (moment: unknown): boolean =>
  !(moment instanceof Date) || (moment >= MIN_DATE && moment <= MAX_DATE)

const dimensionOf: Readonly<Record<string, string | undefined>> = MetricDimensionsOf

const rolledUpMetricNames = Object.keys(RolledUpMetrics) as [RolledUpMetric, ...RolledUpMetric[]]

// A day is a UTC day, as it is in the rollup. A range is [from, to): the point at `to` is not in it.
export const metricsQuerySchema = z
  .strictObject({
    metric: z.enum(rolledUpMetricNames),
    granularity: z.enum(TimeGranularity).default(TimeGranularity.DAY),
    from: z.iso.datetime({ offset: true }).transform(value => new Date(value)),
    to: z.iso.datetime({ offset: true }).transform(value => new Date(value)),
    // Asking for the breakdown of a metric that has one (by channel, by agent); the whole-store series otherwise
    dimension: z.enum(MetricDimensions).default(MetricDimensions.NONE)
  })
  .refine(query => query.dimension === (dimensionOf[query.metric] ?? MetricDimensions.NONE), {
    path: ['dimension'],
    message:
      'a metric is read by its breakdown when it has one, and by the whole store when it has none'
  })
  .refine(query => inBounds(query.from) && inBounds(query.to), {
    path: ['to'],
    message: 'the dates are out of range'
  })
  .refine(query => spanOf(query) === null || (spanOf(query) ?? 0) > 0, {
    path: ['to'],
    message: 'to must be after from'
  })
  .refine(
    query =>
      query.granularity !== TimeGranularity.HOUR ||
      (spanOf(query) ?? 0) <= MetricQueryLimits.MAX_HOURLY_RANGE_DAYS * DAY_MS,
    { path: ['to'], message: 'the range is too long for hours' }
  )
  .refine(query => (spanOf(query) ?? 0) <= MetricQueryLimits.MAX_DAILY_RANGE_DAYS * DAY_MS, {
    path: ['to'],
    message: 'the range is too long'
  })
export type MetricsQuery = z.output<typeof metricsQuerySchema>
