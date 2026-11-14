import { TimeGranularity } from '@platform/core/analytics'
import type { PrismaService } from '@platform/core/database'

import type { BucketRow } from './metrics-aggregation'
import { dayRangeOf } from './metrics-range'

export interface MetricRead {
  metric: string
  granularity: (typeof TimeGranularity)[keyof typeof TimeGranularity]
  dimension: string
  from: Date
  to: Date
}

// The rows of one metric of one store from the rollup tables (TDD_08 §6), never a raw table: an hour comes from
// metrics_hourly; a day, a week and a month come from metrics_daily. Shared by the dashboard (api) and the reports (worker),
// so the two read the same figures. The store is the one the caller resolved, never a value of a request body.
export function readMetricBuckets(
  prisma: PrismaService,
  storeId: string,
  read: MetricRead
): Promise<BucketRow[]> {
  return read.granularity === TimeGranularity.HOUR
    ? hourly(prisma, storeId, read)
    : daily(prisma, storeId, read)
}

function hourly(prisma: PrismaService, storeId: string, read: MetricRead): Promise<BucketRow[]> {
  return prisma.client.$queryRaw<BucketRow[]>`
      SELECT dimension_id AS "dimensionId", hour AS bucket,
             SUM(value)::float8 AS total, SUM(value * count)::float8 AS weighted, SUM(count)::int AS count,
             (ARRAY_AGG(value ORDER BY hour DESC))[1]::float8 AS last,
             (ARRAY_AGG(count ORDER BY hour DESC))[1]::int AS "lastCount"
      FROM metrics_hourly
      WHERE store_id = ${storeId} AND metric = ${read.metric} AND dimension = ${read.dimension}
        AND hour >= ${read.from.toISOString()}::timestamp AND hour < ${read.to.toISOString()}::timestamp
      GROUP BY dimension_id, hour
      ORDER BY hour ASC`
}

function daily(prisma: PrismaService, storeId: string, read: MetricRead): Promise<BucketRow[]> {
  const { from, to } = dayRangeOf(read.granularity, read.from, read.to)
  // The unit of the bucket comes from the closed set of granularities, passed as a value, never joined into the text
  return prisma.client.$queryRaw<BucketRow[]>`
      SELECT dimension_id AS "dimensionId", DATE_TRUNC(${read.granularity}::text, date::timestamp) AS bucket,
             SUM(value)::float8 AS total, SUM(value * count)::float8 AS weighted, SUM(count)::int AS count,
             (ARRAY_AGG(value ORDER BY date DESC))[1]::float8 AS last,
             (ARRAY_AGG(count ORDER BY date DESC))[1]::int AS "lastCount"
      FROM metrics_daily
      WHERE store_id = ${storeId} AND metric = ${read.metric} AND dimension = ${read.dimension}
        AND date >= ${from}::date AND date < ${to}::date
      GROUP BY dimension_id, bucket
      ORDER BY bucket ASC`
}
