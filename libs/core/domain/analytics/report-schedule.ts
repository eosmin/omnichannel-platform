import { ReportFrequency, type ReportFrequencyType } from './analytics-constants'
import { ReportLimits } from './report-constants'

type Frequency = ReportFrequencyType

const DAY_MS = 86_400_000
const CALENDAR_DAY_LENGTH = 10 // "2026-11-12"

// A time zone name the runtime knows: `Intl` refuses the others with a RangeError
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

export interface LocalMoment {
  // The calendar day in the zone, "2026-11-14"
  day: string
  hour: number
  // 1 = Monday ... 7 = Sunday
  weekday: number
  dayOfMonth: number
}

// What the clock of a zone says at a moment. The parts come from Intl, so daylight saving time is the runtime's own.
export function localMoment(now: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short'
  }).formatToParts(now)
  const of = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return {
    day: `${of('year')}-${of('month')}-${of('day')}`,
    hour: Number(of('hour')),
    weekday: weekdays.indexOf(of('weekday')) + 1,
    dayOfMonth: Number(of('day'))
  }
}

// The day of its zone that a report is owed for, or null while its hour of today has not come: today (daily), the latest Monday
// (weekly) or the latest first of the month (monthly) at or before today, by the clock of its own zone. The hour gates the whole
// run, so a worker that was down on the day itself still makes the report on the next day, once its hour comes (it is made up for,
// not lost), and `madeOnDay` against this day stops a second one.
export function reportDueDay(
  frequency: Frequency,
  local: LocalMoment,
  sendAtHour: number
): string | null {
  if (local.hour < sendAtHour) return null
  if (frequency === ReportFrequency.DAILY) return local.day
  if (frequency === ReportFrequency.WEEKLY) return shiftDay(local.day, -(local.weekday - 1))
  return `${local.day.slice(0, 8)}01`
}

const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, CALENDAR_DAY_LENGTH)

export interface ReportPeriod {
  // Calendar days: the first is in, the last is out. The rollup cuts its days in UTC, so these are UTC days.
  from: string
  to: string
}

// The period a report covers when it is made on `day` (the day of its zone): the day, the week or the month that just ended
export function reportPeriod(frequency: Frequency, day: string): ReportPeriod {
  if (frequency === ReportFrequency.DAILY) return { from: shiftDay(day, -1), to: day }
  if (frequency === ReportFrequency.WEEKLY) return { from: shiftDay(day, -7), to: day }
  const firstOfMonth = `${day.slice(0, 8)}01`
  const lastOfPrevious = shiftDay(firstOfMonth, -1)
  return { from: `${lastOfPrevious.slice(0, 8)}01`, to: firstOfMonth }
}

// The days of a period, oldest first
export function daysOfPeriod(period: ReportPeriod): string[] {
  const days: string[] = []
  for (let day = period.from; day < period.to; day = shiftDay(day, 1)) days.push(day)
  return days
}

// Whether the report was already made on that calendar day of its zone
export function madeOnDay(lastSentAt: Date | null, timeZone: string, day: string): boolean {
  return lastSentAt !== null && localMoment(lastSentAt, timeZone).day >= day
}

// Whether the figures of the period are in: the rollup cuts its days in UTC and writes the last one after midnight UTC (00:15, then
// its jobs), so a period is only read once its last day closed and the rollup had time to write it. A zone ahead of UTC reaches its
// hour before that: the report waits for the rollup, it is not sent with a day half done.
export function reportRollupReady(frequency: Frequency, day: string, now: Date): boolean {
  const closedAt = Date.parse(`${reportPeriod(frequency, day).to}T00:00:00.000Z`)
  return now.getTime() >= closedAt + ReportLimits.ROLLUP_READY_GRACE_MS
}
