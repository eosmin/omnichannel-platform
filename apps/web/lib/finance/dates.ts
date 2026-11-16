import { isIsoDate } from '@platform/core/finance'

// An accounting date is a day, 'YYYY-MM-DD', and a real one (no 31 of February): the api refuses anything else, and the form says so first
export const isCalendarDay = isIsoDate

// The day of a clock as the books write it ('YYYY-MM-DD'), in the zone of the person: what a form suggests for "today"
export const dayOfClock = (clock: Date): string =>
  `${String(clock.getFullYear())}-${String(clock.getMonth() + 1).padStart(2, '0')}-${String(clock.getDate()).padStart(2, '0')}`

// The UTC day of a clock: the day the api reckons its limits from
export const dayOfUtcClock = (clock: Date): string =>
  `${String(clock.getUTCFullYear()).padStart(4, '0')}-${String(clock.getUTCMonth() + 1).padStart(2, '0')}-${String(clock.getUTCDate()).padStart(2, '0')}`

// The day after a day, by the calendar (no zone in it); the api accepts a transaction dated up to a day ahead of its own today
export function nextDay(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  return dayOfUtcClock(new Date(Date.UTC(year, month - 1, date + 1)))
}
