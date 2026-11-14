import type { MetricSeriesView, MetricsResultView } from '@platform/api-client'
import { AnalyticsMetrics, type RolledUpMetric } from '@platform/core/analytics'

// The four figures on top of the dashboard (TDD_11 §7.3): what each reads, how it is written and which direction is better
export const KpiKinds = { COUNT: 'count', DURATION: 'duration', MONEY: 'money' } as const
export type KpiKind = (typeof KpiKinds)[keyof typeof KpiKinds]

export interface KpiDefinition {
  id: 'conversations' | 'firstResponse' | 'resolution' | 'revenue'
  metric: RolledUpMetric
  kind: KpiKind
  // A time that goes down is an improvement; a count that goes up is
  betterWhen: 'higher' | 'lower'
}

export const KPIS: readonly KpiDefinition[] = [
  {
    id: 'conversations',
    metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
    kind: KpiKinds.COUNT,
    betterWhen: 'higher'
  },
  {
    id: 'firstResponse',
    metric: AnalyticsMetrics.FIRST_RESPONSE_TIME,
    kind: KpiKinds.DURATION,
    betterWhen: 'lower'
  },
  {
    id: 'resolution',
    metric: AnalyticsMetrics.RESOLUTION_TIME,
    kind: KpiKinds.DURATION,
    betterWhen: 'lower'
  },
  {
    id: 'revenue',
    metric: AnalyticsMetrics.ORDERS_REVENUE,
    kind: KpiKinds.MONEY,
    betterWhen: 'higher'
  }
]

// The summary of a whole-store series (the answer of a metric with no breakdown has one series, or none when nothing happened)
export function wholeStoreSummary(
  result: MetricsResultView | undefined
): { value: number; count: number } | null {
  const series = result?.series[0]
  return series === undefined ? null : series.summary
}

// The change from the period before, as a fraction (0.123 is +12.3%); null when there is nothing to compare with
export function changeOf(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null
  return (current - previous) / previous
}

export const ChangeTones = { BETTER: 'better', WORSE: 'worse', SAME: 'same' } as const
export type ChangeTone = (typeof ChangeTones)[keyof typeof ChangeTones]

// A change under half a percent is "no change": the sign of noise would say more than the data does
const SAME_BELOW = 0.005

export function toneOf(change: number, betterWhen: KpiDefinition['betterWhen']): ChangeTone {
  if (Math.abs(change) < SAME_BELOW) return ChangeTones.SAME
  const improved = betterWhen === 'higher' ? change > 0 : change < 0
  return improved ? ChangeTones.BETTER : ChangeTones.WORSE
}

// A point for every day of the range: a day with no row is a day with nothing in it (the rollup writes no row for a zero),
// so the line of a count goes to zero instead of skipping the day
export function dailyValues(
  series: MetricSeriesView | undefined,
  days: readonly string[]
): number[] {
  const byDay = new Map(
    (series?.points ?? []).map(point => [point.timestamp.slice(0, 10), point.value])
  )
  return days.map(day => byDay.get(day) ?? 0)
}

export interface BreakdownRow {
  id: string
  value: number
  count: number
}

// The breakdown of a metric by its dimension, the biggest first; ties by id so the order does not jump between reads
export function breakdownOf(result: MetricsResultView | undefined): BreakdownRow[] {
  return (result?.series ?? [])
    .map(series => ({
      id: series.dimensionId,
      value: series.summary.value,
      count: series.summary.count
    }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
}
