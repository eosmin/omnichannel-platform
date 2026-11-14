import { Injectable } from '@nestjs/common'

import {
  type AnalyticsMetric,
  type MetricAggregation,
  RolledUpMetrics,
  TimeGranularity,
  type TimeGranularityType
} from '@platform/core/analytics'
import { PrismaService } from '@platform/core/database'
import {
  buildSeries,
  dayRangeOf,
  type MetricSeries,
  readMetricBuckets
} from '@platform/core/messaging'

import type { MetricsQuery } from './metrics.schemas'

export interface MetricsResult {
  metric: AnalyticsMetric
  granularity: TimeGranularityType
  dimension: string
  // How the points of a coarser bucket are put together: a time of a week or a month is the mean of its days' medians
  // weighted by their conversations, not the median of the period
  aggregation: MetricAggregation
  from: string
  to: string
  series: MetricSeries[]
}

// The metrics of a store for the dashboard (TDD_08 §6): it reads only the rollup tables, never a raw one. An hour comes from
// metrics_hourly; a day, a week and a month come from metrics_daily. The store is the one TenantGuard resolved.
@Injectable()
export class MetricsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async query(storeId: string, query: MetricsQuery): Promise<MetricsResult> {
    const rows = await readMetricBuckets(this.prisma, storeId, query)
    const aggregation = RolledUpMetrics[query.metric]
    const effective =
      query.granularity === TimeGranularity.HOUR
        ? { from: query.from.toISOString(), to: query.to.toISOString() }
        : this.daysOf(query)
    return {
      aggregation,
      metric: query.metric,
      granularity: query.granularity,
      dimension: query.dimension,
      // The range that was read: whole days for the daily table, starting at the first day of a week or a month
      from: effective.from,
      to: effective.to,
      series: buildSeries(aggregation, rows)
    }
  }

  private daysOf(query: MetricsQuery): { from: string; to: string } {
    const { from, to } = dayRangeOf(query.granularity, query.from, query.to)
    return { from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z` }
  }
}
