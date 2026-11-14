import { Injectable } from '@nestjs/common'

import {
  AnalyticsMetrics,
  type AnalyticsMetric,
  MetricDimensions,
  RolledUpMetrics,
  RollupLimits
} from '@platform/core/analytics'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import { AuthorType, ConversationStatus, MessageType, OrderStatus } from '@platform/core/domain'
import { JobNames, rollupLockKey } from '@platform/core/queues'

import { RollupGranularities, type RollupGranularity, type RollupPeriod } from './rollup-periods'

export interface MetricRow {
  metric: AnalyticsMetric
  dimension: string
  dimensionId: string
  value: number
  count: number
}

interface TimeStats {
  median: number | null
  count: number
}
interface Grouped {
  key: string
  count: number
}

const CENTS_PER_UNIT = 100
const DAY_MS = 86_400_000

const rolledUpMetrics = Object.keys(RolledUpMetrics)

const JobNameOf = {
  [RollupGranularities.HOURLY]: JobNames.ROLLUP_HOURLY,
  [RollupGranularities.DAILY]: JobNames.ROLLUP_DAILY
} as const

const TRANSACTION = {
  maxWait: RollupLimits.TRANSACTION_MAX_WAIT_MS,
  timeout: RollupLimits.TRANSACTION_TIMEOUT_MS
}

// The rollups of TDD_11 §7.2 / TDD_08 §6: every metric of one store for one period (an hour or a UTC day), computed from the raw
// tables and written to metrics_hourly or metrics_daily. A run replaces what the period holds, in one transaction, so running it
// again (a late webhook, a redelivered job) gives the same rows and never leaves one behind that the data no longer supports.
//
// Each fact is dated by when it happened, not by when its conversation began: a first answer that comes hours after the
// conversation was created belongs to the hour it came, which the two-period recompute then still reaches. The store id is the
// one of the job and every query is filtered by it.
@Injectable()
export class AnalyticsRollupService {
  constructor(private readonly prisma: PrismaService) {}

  async rollup(
    granularity: RollupGranularity,
    storeId: string,
    period: RollupPeriod
  ): Promise<MetricRow[]> {
    return this.prisma.transaction(async tx => {
      // One run per store and period at a time: two that interleave could both insert the same row
      const lockKey = rollupLockKey(JobNameOf[granularity], storeId, period.start)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      const rows = await this.compute(tx, storeId, period)
      await this.replace(tx, granularity, storeId, period, rows)
      return rows
    }, TRANSACTION)
  }

  private async compute(
    tx: PrismaTransaction,
    storeId: string,
    { start, end }: RollupPeriod
  ): Promise<MetricRow[]> {
    const rows: MetricRow[] = []
    // A metric with nothing in the period has no row: the reads take a missing row as zero, so an idle store costs the tables
    // nothing, and a row that the data no longer supports is gone with the delete of the run
    const add = (
      metric: AnalyticsMetric,
      value: number,
      count: number,
      dimension: string = MetricDimensions.NONE,
      dimensionId = ''
    ): void => {
      // A count of the moment is kept at zero too: with no row, a read would carry the last count that has one
      if (value === 0 && count === 0 && metric !== AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON)
        return
      rows.push({ metric, dimension, dimensionId, value, count })
    }
    // A time is kept when at least one conversation is behind it: a median of nothing is not zero
    const addTime = (metric: AnalyticsMetric, stats: TimeStats): void => {
      if (stats.median !== null && stats.count > 0) add(metric, stats.median, stats.count)
    }

    // One connection, so one query at a time
    const created = await this.countCreated(tx, storeId, start, end)
    const createdByChannel = await this.createdByChannel(tx, storeId, start, end)
    const resolved = await this.countResolved(tx, storeId, start, end)
    const resolvedByAgent = await this.resolvedByAgent(tx, storeId, start, end)
    const firstResponse = await this.firstResponse(tx, storeId, start, end, 'first_response_at')
    const firstAutomated = await this.firstResponse(
      tx,
      storeId,
      start,
      end,
      'first_automated_response_at'
    )
    const resolution = await this.resolutionTime(tx, storeId, start, end)
    const received = await this.countMessages(tx, storeId, start, end, AuthorType.CUSTOMER)
    const sent = await this.countMessages(tx, storeId, start, end, AuthorType.AGENT)
    const waiting = await this.countWaiting(tx, storeId, end)
    const answeredByAutomation = await this.countAnsweredByAutomation(tx, storeId, start, end)
    const resolvedByAutomation = await this.countResolvedByAutomation(tx, storeId, start, end)
    const orders = await this.orderTotals(tx, storeId, start, end)

    add(AnalyticsMetrics.CONVERSATIONS_CREATED, created, created)
    add(AnalyticsMetrics.CONVERSATIONS_RESOLVED, resolved, resolved)
    add(AnalyticsMetrics.MESSAGES_RECEIVED, received, received)
    add(AnalyticsMetrics.MESSAGES_SENT, sent, sent)
    add(AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON, waiting, waiting)
    add(
      AnalyticsMetrics.CONVERSATIONS_ANSWERED_AUTOMATION,
      answeredByAutomation,
      answeredByAutomation
    )
    add(
      AnalyticsMetrics.CONVERSATIONS_RESOLVED_AUTOMATION,
      resolvedByAutomation,
      resolvedByAutomation
    )
    add(AnalyticsMetrics.ORDERS_CREATED, orders.count, orders.count)
    add(AnalyticsMetrics.ORDERS_REVENUE, orders.totalCents / CENTS_PER_UNIT, orders.count)
    addTime(AnalyticsMetrics.FIRST_RESPONSE_TIME, firstResponse)
    addTime(AnalyticsMetrics.FIRST_AUTOMATED_RESPONSE_TIME, firstAutomated)
    addTime(AnalyticsMetrics.RESOLUTION_TIME, resolution)
    for (const row of createdByChannel) {
      add(AnalyticsMetrics.CHANNEL_VOLUME, row.count, row.count, MetricDimensions.CHANNEL, row.key)
    }
    for (const row of resolvedByAgent) {
      add(
        AnalyticsMetrics.CONVERSATIONS_PER_AGENT,
        row.count,
        row.count,
        MetricDimensions.AGENT,
        row.key
      )
    }
    return rows
  }

  private async replace(
    tx: PrismaTransaction,
    granularity: RollupGranularity,
    storeId: string,
    { start }: RollupPeriod,
    rows: MetricRow[]
  ): Promise<void> {
    if (granularity === RollupGranularities.HOURLY) {
      await tx.metricHourly.deleteMany({
        where: { storeId, hour: start, metric: { in: rolledUpMetrics } }
      })
      await tx.metricHourly.createMany({
        data: rows.map(row => ({ storeId, hour: start, ...row }))
      })
      return
    }
    await tx.metricDaily.deleteMany({
      where: { storeId, date: start, metric: { in: rolledUpMetrics } }
    })
    await tx.metricDaily.createMany({ data: rows.map(row => ({ storeId, date: start, ...row })) })
  }

  private async countCreated(tx: PrismaTransaction, storeId: string, start: Date, end: Date) {
    const [row] = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM conversations
      WHERE store_id = ${storeId} AND created_at >= ${start.toISOString()}::timestamp AND created_at < ${end.toISOString()}::timestamp`
    return row?.n ?? 0
  }

  private createdByChannel(tx: PrismaTransaction, storeId: string, start: Date, end: Date) {
    return tx.$queryRaw<Grouped[]>`
      SELECT channel_type AS key, COUNT(*)::int AS count FROM conversations
      WHERE store_id = ${storeId} AND created_at >= ${start.toISOString()}::timestamp AND created_at < ${end.toISOString()}::timestamp
      GROUP BY channel_type`
  }

  private async countResolved(tx: PrismaTransaction, storeId: string, start: Date, end: Date) {
    const [row] = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM conversations
      WHERE store_id = ${storeId} AND resolved_at >= ${start.toISOString()}::timestamp AND resolved_at < ${end.toISOString()}::timestamp`
    return row?.n ?? 0
  }

  // Resolved by whoever the conversation was assigned to when it was resolved: the resolve does not keep its own author column
  private resolvedByAgent(tx: PrismaTransaction, storeId: string, start: Date, end: Date) {
    return tx.$queryRaw<Grouped[]>`
      SELECT assigned_to AS key, COUNT(*)::int AS count FROM conversations
      WHERE store_id = ${storeId} AND resolved_at >= ${start.toISOString()}::timestamp AND resolved_at < ${end.toISOString()}::timestamp
        AND assigned_to IS NOT NULL
      GROUP BY assigned_to`
  }

  // The median of the seconds between the creation of a conversation and its first answer, for the answers that came in the
  // period. `column` is one of two names of this file, never input.
  private async firstResponse(
    tx: PrismaTransaction,
    storeId: string,
    start: Date,
    end: Date,
    column: 'first_response_at' | 'first_automated_response_at'
  ): Promise<TimeStats> {
    const [row] =
      column === 'first_response_at'
        ? await tx.$queryRaw<TimeStats[]>`
            SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)))::float8 AS median,
                   COUNT(*)::int AS count
            FROM conversations
            WHERE store_id = ${storeId}
              AND first_response_at >= ${start.toISOString()}::timestamp AND first_response_at < ${end.toISOString()}::timestamp`
        : await tx.$queryRaw<TimeStats[]>`
            SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_automated_response_at - created_at)))::float8 AS median,
                   COUNT(*)::int AS count
            FROM conversations
            WHERE store_id = ${storeId}
              AND first_automated_response_at >= ${start.toISOString()}::timestamp AND first_automated_response_at < ${end.toISOString()}::timestamp`
    return row ?? { median: null, count: 0 }
  }

  private async resolutionTime(
    tx: PrismaTransaction,
    storeId: string,
    start: Date,
    end: Date
  ): Promise<TimeStats> {
    const [row] = await tx.$queryRaw<TimeStats[]>`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)))::float8 AS median,
             COUNT(*)::int AS count
      FROM conversations
      WHERE store_id = ${storeId} AND resolved_at >= ${start.toISOString()}::timestamp AND resolved_at < ${end.toISOString()}::timestamp`
    return row ?? { median: null, count: 0 }
  }

  // The team's volume: what customers wrote and what agents sent. An internal note is not a message to anyone.
  private async countMessages(
    tx: PrismaTransaction,
    storeId: string,
    start: Date,
    end: Date,
    authorType: AuthorType
  ) {
    const [row] = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM messages
      WHERE store_id = ${storeId} AND created_at >= ${start.toISOString()}::timestamp AND created_at < ${end.toISOString()}::timestamp
        AND author_type = ${authorType} AND type <> ${MessageType.INTERNAL_NOTE}`
    return row?.n ?? 0
  }

  // Waiting for a person at the end of the period: no reply of a person and not resolved by then. Spam and what was archived
  // are in nobody's queue, and one with no attention for WAITING_LOOKBACK_DAYS is no longer counted: the read stays on the
  // index of the store and the period instead of the whole history.
  private async countWaiting(tx: PrismaTransaction, storeId: string, end: Date) {
    const lookback = new Date(end.getTime() - RollupLimits.WAITING_LOOKBACK_DAYS * DAY_MS)
    const [row] = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM conversations
      WHERE store_id = ${storeId} AND created_at < ${end.toISOString()}::timestamp
        AND created_at >= ${lookback.toISOString()}::timestamp
        AND status NOT IN (${ConversationStatus.SPAM}, ${ConversationStatus.ARCHIVED})
        AND (first_response_at IS NULL OR first_response_at >= ${end.toISOString()}::timestamp)
        AND (resolved_at IS NULL OR resolved_at >= ${end.toISOString()}::timestamp)`
    return row?.n ?? 0
  }

  private async countAnsweredByAutomation(
    tx: PrismaTransaction,
    storeId: string,
    start: Date,
    end: Date
  ) {
    const [row] = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM conversations
      WHERE store_id = ${storeId}
        AND first_automated_response_at >= ${start.toISOString()}::timestamp AND first_automated_response_at < ${end.toISOString()}::timestamp
        AND (first_response_at IS NULL OR first_response_at > first_automated_response_at)`
    return row?.n ?? 0
  }

  private async countResolvedByAutomation(
    tx: PrismaTransaction,
    storeId: string,
    start: Date,
    end: Date
  ) {
    const [row] = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM conversations
      WHERE store_id = ${storeId}
        AND resolved_at >= ${start.toISOString()}::timestamp AND resolved_at < ${end.toISOString()}::timestamp
        AND first_automated_response_at IS NOT NULL AND first_automated_response_at <= resolved_at
        AND (first_response_at IS NULL OR first_response_at > resolved_at)`
    return row?.n ?? 0
  }

  // A cancelled order is not revenue
  private async orderTotals(tx: PrismaTransaction, storeId: string, start: Date, end: Date) {
    const [row] = await tx.$queryRaw<{ count: number; total: number }[]>`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(total_cents), 0)::float8 AS total FROM orders
      WHERE store_id = ${storeId} AND created_at >= ${start.toISOString()}::timestamp AND created_at < ${end.toISOString()}::timestamp
        AND status <> ${OrderStatus.CANCELLED}`
    return { count: row?.count ?? 0, totalCents: row?.total ?? 0 }
  }
}
