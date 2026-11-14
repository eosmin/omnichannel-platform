import {
  type AnalyticsExportFilters,
  daysOfPeriod,
  MetricAggregations,
  MetricDimensions,
  RolledUpMetrics,
  TimeGranularity,
  type ReportMetric
} from '@platform/core/analytics'
import type { PrismaService } from '@platform/core/database'
import { buildSeries, type BucketRow, readMetricBuckets } from '@platform/core/messaging'

// The figures of a report: one row for each UTC day of the period and a column for each metric, then the figure of the whole period
export interface ReportTable {
  metrics: readonly ReportMetric[]
  rows: { day: string; values: (number | null)[] }[]
  totals: (number | null)[]
}

const DAY_ISO_LENGTH = 10

// A count that the rollup did not write is zero (an idle day writes no row); a time or a count of the moment that it did not
// write is unknown, and stays empty instead of saying zero
function missingValue(metric: ReportMetric): number | null {
  return RolledUpMetrics[metric] === MetricAggregations.SUM ? 0 : null
}

// Pure: the rows the rollup tables gave for each metric, put together as the dashboard puts them together
export function buildReportTable(
  filters: Pick<AnalyticsExportFilters, 'metrics' | 'from' | 'to'>,
  bucketsOf: ReadonlyMap<ReportMetric, BucketRow[]>
): ReportTable {
  const days = daysOfPeriod(filters)
  const columns = filters.metrics.map(metric => {
    const aggregation = RolledUpMetrics[metric]
    const series = buildSeries(aggregation, bucketsOf.get(metric) ?? [])[0]
    const byDay = new Map(
      (series?.points ?? []).map(point => [point.timestamp.slice(0, DAY_ISO_LENGTH), point.value])
    )
    const total =
      series === undefined || series.points.length === 0
        ? missingValue(metric)
        : series.summary.value
    return { byDay, total, metric }
  })
  return {
    metrics: filters.metrics,
    rows: days.map(day => ({
      day,
      values: columns.map(column => column.byDay.get(day) ?? missingValue(column.metric))
    })),
    totals: columns.map(column => column.total)
  }
}

// Reads the rollup tables only. The store is the one of the row of the export, never a value of the filters.
export async function readReportTable(
  prisma: PrismaService,
  storeId: string,
  filters: Pick<AnalyticsExportFilters, 'metrics' | 'from' | 'to'>
): Promise<ReportTable> {
  const from = new Date(`${filters.from}T00:00:00.000Z`)
  const to = new Date(`${filters.to}T00:00:00.000Z`)
  const entries = await Promise.all(
    filters.metrics.map(
      async metric =>
        [
          metric,
          await readMetricBuckets(prisma, storeId, {
            metric,
            granularity: TimeGranularity.DAY,
            dimension: MetricDimensions.NONE,
            from,
            to
          })
        ] as const
    )
  )
  return buildReportTable(filters, new Map(entries))
}
