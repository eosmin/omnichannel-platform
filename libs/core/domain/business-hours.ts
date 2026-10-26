import type { Weekday } from './settings-constants'

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
