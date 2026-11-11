import {
  OrderScheduledDeliveryShortcuts,
  type OrderScheduledDeliveryShortcut
} from './order-constants'
import { DAY_MS } from './time-constants'

// The scheduled delivery day is a calendar day of the store ('YYYY-MM-DD', decision D18), never a moment: "today" is
// the day it is on the clock of the store's timezone, which is not the day of the server.

// The calendar day an instant falls on in a timezone, as 'YYYY-MM-DD'
// Building a formatter is the costly part and a store has one timezone. A timezone the runtime does not know throws a
// RangeError here: the timezone of a store is validated when it is saved, and a wrong day would be worse than the error.
const formatters = new Map<string, Intl.DateTimeFormat>()

export function calendarDayIn(timezone: string, at: Date): string {
  let formatter = formatters.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    formatters.set(timezone, formatter)
  }
  // Built from the parts, not from the layout of a locale
  const parts: Record<string, string> = {}
  for (const { type, value } of formatter.formatToParts(at)) parts[type] = value
  return `${parts['year']}-${parts['month']}-${parts['day']}`
}

// The column is a DATE (`Order.scheduledDeliveryDate`, Prisma reads and writes it as a Date at UTC midnight) and the
// API speaks 'YYYY-MM-DD': these two are the only conversions between them
// A day that does not exist ('2026-02-30', which Date would roll into March) is an error here, never a wrong day
export function calendarDayToDate(day: string): Date {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || dateToCalendarDay(date) !== day) {
    throw new RangeError('not a calendar day')
  }
  return date
}

export function dateToCalendarDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// The next calendar day: days have no length, so the sum is made in UTC where no day is 23 or 25 hours long
export function nextCalendarDay(day: string): string {
  return dateToCalendarDay(new Date(calendarDayToDate(day).getTime() + DAY_MS))
}

export interface ScheduledDeliveryRange {
  // Inclusive days; null is no bound on that side
  readonly from: string | null
  readonly to: string | null
}

// The shortcut `scheduledDeliveryOn` is one day: the range is that day on both sides
export function scheduledDeliveryShortcutRange(
  shortcut: OrderScheduledDeliveryShortcut,
  timezone: string,
  now: Date
): ScheduledDeliveryRange {
  const today = calendarDayIn(timezone, now)
  const day = shortcut === OrderScheduledDeliveryShortcuts.TODAY ? today : nextCalendarDay(today)
  return { from: day, to: day }
}

// The instant a calendar day starts in a timezone: the first moment of the day on the clock of the store. A day that is
// 23 or 25 hours long changes nothing here, the next day starts where this one ends (`startOfCalendarDayIn(next)`).
// Found by correcting a guess with the offset the zone has at it, twice, which also settles the days a clock change
// falls in. The filters of the orders list ("the day it was made") are cut with it, not on the day of the server.
export function startOfCalendarDayIn(timezone: string, day: string): Date {
  const midnightUtc = calendarDayToDate(day).getTime()
  let guess = midnightUtc
  for (let attempt = 0; attempt < 2; attempt += 1) {
    guess = midnightUtc - zoneOffsetMs(timezone, new Date(guess))
  }
  return new Date(guess)
}

// How far the clock of the zone is ahead of UTC at an instant
function zoneOffsetMs(timezone: string, at: Date): number {
  const parts: Record<string, string> = {}
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  for (const { type, value } of formatter.formatToParts(at)) parts[type] = value
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second'])
  )
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}
