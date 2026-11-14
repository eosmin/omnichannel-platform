import { TimeGranularity, type TimeGranularityType } from '@platform/core/analytics'

const DAY_MS = 86_400_000
const DAY_LENGTH = 10 // "2026-11-12" in an ISO date

export interface DayRange {
  // ISO dates: the first day is in, the last is out
  from: string
  to: string
}

const midnight = (moment: Date): number => Math.floor(moment.getTime() / DAY_MS) * DAY_MS

// The first day of the week (Monday, as DATE_TRUNC('week') has it) or of the month that holds the day, in UTC
function bucketStart(granularity: TimeGranularityType, dayStart: number): number {
  if (granularity === TimeGranularity.WEEK) {
    const sinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7
    return dayStart - sinceMonday * DAY_MS
  }
  if (granularity === TimeGranularity.MONTH) {
    const day = new Date(dayStart)
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)
  }
  return dayStart
}

// The days a read of the daily table covers. The range is read in whole UTC days: the day of `to` is in when `to` is past its
// midnight, so a range inside one day is that day and not nothing. A week or a month starts at its first day, so that the bucket
// that the range begins in is never a part of a week or a month under the label of the whole one.
export function dayRangeOf(granularity: TimeGranularityType, from: Date, to: Date): DayRange {
  const toMidnight = midnight(to)
  const toExclusive = toMidnight === to.getTime() ? toMidnight : toMidnight + DAY_MS
  return {
    from: new Date(bucketStart(granularity, midnight(from))).toISOString().slice(0, DAY_LENGTH),
    to: new Date(toExclusive).toISOString().slice(0, DAY_LENGTH)
  }
}
