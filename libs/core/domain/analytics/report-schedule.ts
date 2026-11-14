import { ReportFrequency, type ReportFrequencyType } from './analytics-constants'

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

// A report is made from its hour of the day on, on every day (daily), on Mondays (weekly) or on the first of the month (monthly),
// by the clock of its own zone. From its hour and not only at it: a tick that was missed (the worker was down, an hour that the
// clock skipped) is made up for in the next ones, and `madeOnDay` stops a second one.
export function isReportDue(frequency: Frequency, local: LocalMoment, sendAtHour: number): boolean {
  if (local.hour < sendAtHour) return false
  if (frequency === ReportFrequency.DAILY) return true
  if (frequency === ReportFrequency.WEEKLY) return local.weekday === 1
  return local.dayOfMonth === 1
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
