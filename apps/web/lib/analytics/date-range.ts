import { DateRangePresets } from '@platform/core/analytics'

// The ranges the dashboard offers. A day is a UTC day, as it is in the rollup tables (a store's own zone for the day buckets
// is not built yet: Step 5.2, "Left by PR B"), and a range is [from, to) with `to` the start of today: the rollup writes a day
// when it closes, so today has no figure yet (the My performance widget of the inbox reads today live).
export const AnalyticsRanges = [
  DateRangePresets.LAST_7_DAYS,
  DateRangePresets.LAST_30_DAYS,
  DateRangePresets.LAST_90_DAYS,
  DateRangePresets.LAST_MONTH
] as const
export type AnalyticsRange = (typeof AnalyticsRanges)[number]

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = DateRangePresets.LAST_30_DAYS

export interface DayRange {
  // Inclusive start, exclusive end: both are UTC midnights
  from: Date
  to: Date
}

const DAY_MS = 86_400_000
const DAYS_OF: Record<Exclude<AnalyticsRange, typeof DateRangePresets.LAST_MONTH>, number> = {
  [DateRangePresets.LAST_7_DAYS]: 7,
  [DateRangePresets.LAST_30_DAYS]: 30,
  [DateRangePresets.LAST_90_DAYS]: 90
}

export function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return AnalyticsRanges.some(range => range === value)
}

const startOfUtcDay = (moment: Date): Date =>
  new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate()))

const startOfUtcMonth = (year: number, month: number): Date => new Date(Date.UTC(year, month, 1))

export function rangeOf(range: AnalyticsRange, now: Date): DayRange {
  const today = startOfUtcDay(now)
  if (range === DateRangePresets.LAST_MONTH) {
    return {
      from: startOfUtcMonth(today.getUTCFullYear(), today.getUTCMonth() - 1),
      to: startOfUtcMonth(today.getUTCFullYear(), today.getUTCMonth())
    }
  }
  return { from: new Date(today.getTime() - DAYS_OF[range] * DAY_MS), to: today }
}

// What the figures are compared with: the period of the same length right before (the month before, for a month)
export function previousRangeOf(range: AnalyticsRange, now: Date): DayRange {
  const current = rangeOf(range, now)
  if (range === DateRangePresets.LAST_MONTH) {
    return {
      from: startOfUtcMonth(current.from.getUTCFullYear(), current.from.getUTCMonth() - 1),
      to: current.from
    }
  }
  const length = current.to.getTime() - current.from.getTime()
  return { from: new Date(current.from.getTime() - length), to: current.from }
}

// The UTC days of a range, as `YYYY-MM-DD`, oldest first
export function daysOf(range: DayRange): string[] {
  const days: string[] = []
  for (let at = range.from.getTime(); at < range.to.getTime(); at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10))
  }
  return days
}
