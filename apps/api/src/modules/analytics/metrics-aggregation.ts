import { MetricAggregations, type MetricAggregation } from '@platform/core/analytics'

// What the query of a bucket returns: everything an aggregation may need, so the SQL does not depend on which one is asked
export interface BucketRow {
  dimensionId: string
  bucket: Date
  total: number | null
  weighted: number | null
  count: number
  last: number | null
  lastCount: number
}

export interface MetricPoint {
  timestamp: string
  value: number
  count: number
}

export interface MetricSummary {
  value: number
  count: number
}

export interface MetricSeries {
  dimensionId: string
  points: MetricPoint[]
  summary: MetricSummary
}

function pointOf(aggregation: MetricAggregation, row: BucketRow): MetricPoint | null {
  const timestamp = row.bucket.toISOString()
  switch (aggregation) {
    case MetricAggregations.SUM:
      return { timestamp, value: row.total ?? 0, count: row.count }
    case MetricAggregations.WEIGHTED_MEAN:
      // A bucket with no conversation behind it has no time: it is left out, not shown as zero
      return row.count > 0 && row.weighted !== null
        ? { timestamp, value: row.weighted / row.count, count: row.count }
        : null
    case MetricAggregations.LAST:
      return { timestamp, value: row.last ?? 0, count: row.lastCount }
  }
}

// The same rule one level up: the summary of a range is its points put together as the points are put together from the rows
function summaryOf(aggregation: MetricAggregation, points: MetricPoint[]): MetricSummary {
  const count = points.reduce((sum, point) => sum + point.count, 0)
  switch (aggregation) {
    case MetricAggregations.SUM:
      return { value: points.reduce((sum, point) => sum + point.value, 0), count }
    case MetricAggregations.WEIGHTED_MEAN:
      return {
        value:
          count === 0
            ? 0
            : points.reduce((sum, point) => sum + point.value * point.count, 0) / count,
        count
      }
    case MetricAggregations.LAST: {
      const last = points.at(-1)
      return { value: last?.value ?? 0, count: last?.count ?? 0 }
    }
  }
}

// One series for each dimension id, its points oldest first
export function buildSeries(aggregation: MetricAggregation, rows: BucketRow[]): MetricSeries[] {
  const byDimension = new Map<string, BucketRow[]>()
  for (const row of rows) {
    const group = byDimension.get(row.dimensionId)
    if (group === undefined) byDimension.set(row.dimensionId, [row])
    else group.push(row)
  }
  return [...byDimension.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dimensionId, group]) => {
      const points = group
        .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
        .flatMap(row => pointOf(aggregation, row) ?? [])
      return { dimensionId, points, summary: summaryOf(aggregation, points) }
    })
}
