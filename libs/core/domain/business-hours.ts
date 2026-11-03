import { AwayReply, type Weekday } from './settings-constants'

export type WeekSchedule = Record<Weekday, readonly { from: string; to: string }[]>

const WEEKDAY_BY_SHORT_NAME: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun'
}

// Building a formatter is the costly part and a store has one timezone: they are kept
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    formatters.set(timezone, formatter)
  }
  return formatter
}

// Whether a moment falls inside the schedule of a store, read on the clock of its timezone (daylight
// saving included). A range holds its start and not its end: 09:00 to 18:00 is open at 09:00 and
// closed at 18:00. "24:00" ends at midnight.
export function isWithinSchedule(schedule: WeekSchedule, timezone: string, at: Date): boolean {
  const parts = formatterFor(timezone).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(candidate => candidate.type === type)?.value ?? ''
  const day = WEEKDAY_BY_SHORT_NAME[part('weekday')]
  if (day === undefined) throw new Error(`unknown weekday for ${timezone}: ${part('weekday')}`)
  const clock = `${part('hour')}:${part('minute')}`
  return schedule[day].some(range => range.from <= clock && clock < range.to)
}

// The last moment at or before `at` when the store was open, looking back to `notBefore` and no
// further than `AwayReply.LOOKBACK_MS`; null when it was not open in all that time. The schedule is
// read by the minute, which is how it is written. The reply for a customer who writes while the store
// is closed is sent once for each closed stretch: this says whether the stretch began after a moment.
export function lastOpenBefore(
  schedule: WeekSchedule,
  timezone: string,
  at: Date,
  notBefore?: Date
): Date | null {
  const earliest = Math.max(at.getTime() - AwayReply.LOOKBACK_MS, notBefore?.getTime() ?? 0)
  for (let moment = at.getTime(); moment >= earliest; moment -= AwayReply.STEP_MS) {
    if (isWithinSchedule(schedule, timezone, new Date(moment))) return new Date(moment)
  }
  return null
}
