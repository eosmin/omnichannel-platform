import { SnoozePresets } from '@platform/core/domain'

export enum SnoozePresetId {
  LATER_TODAY = 'laterToday',
  TOMORROW_MORNING = 'tomorrowMorning',
  NEXT_WEEK = 'nextWeek'
}

export interface SnoozePreset {
  id: SnoozePresetId
  until: Date
}

const HOUR_MS = 3_600_000
const MONDAY = 1
const DAYS_IN_WEEK = 7

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const found = formatters.get(timezone)
  if (found !== undefined) return found
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric'
  })
  formatters.set(timezone, created)
  return created
}

// The wall clock of an instant in a timezone
export function wallClockIn(instant: Date, timezone: string): WallClock {
  const parts = Object.fromEntries(
    formatterFor(timezone)
      .formatToParts(instant)
      .map(part => [part.type, Number(part.value)] as const)
  )
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0
  }
}

function asUtcMs(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute)
}

export const DAY_MS = 86_400_000

// How far the wall clock of a zone is ahead of UTC at an instant
function offsetAt(instant: number, timezone: string): number {
  return asUtcMs(wallClockIn(new Date(instant), timezone)) - instant
}

// The instant at which a timezone shows this wall clock. The offsets of the day before and the day
// after bracket a change of offset. Where the clocks repeat an hour (fall back) the first occurrence
// wins; where they skip one (spring forward) the time lands just after the gap.
export function instantAt(clock: WallClock, timezone: string): Date {
  const wanted = asUtcMs(clock)
  const candidates = [offsetAt(wanted - DAY_MS, timezone), offsetAt(wanted + DAY_MS, timezone)]
    .map(offset => wanted - offset)
    .sort((a, b) => a - b)
  const exact = candidates.find(
    candidate => asUtcMs(wallClockIn(new Date(candidate), timezone)) === wanted
  )
  // In a gap neither candidate shows the wanted clock: the later one is past it
  return new Date(exact ?? candidates[candidates.length - 1] ?? wanted)
}

// Day of the week of a calendar date, 0 = Sunday
function weekdayOf(clock: WallClock): number {
  return new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay()
}

function addDays(clock: WallClock, days: number): WallClock {
  const moved = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + days))
  return {
    ...clock,
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate()
  }
}

// The three presets of the menu, counted in the timezone of the store. "Next week" is the coming
// Monday, a week away when today is Monday.
export function snoozePresets(now: Date, timezone: string): SnoozePreset[] {
  const today = wallClockIn(now, timezone)
  const morning = { ...today, hour: SnoozePresets.MORNING_HOUR, minute: 0 }
  const daysToMonday = ((MONDAY - weekdayOf(today) + DAYS_IN_WEEK - 1) % DAYS_IN_WEEK) + 1
  return [
    {
      id: SnoozePresetId.LATER_TODAY,
      until: new Date(now.getTime() + SnoozePresets.LATER_TODAY_HOURS * HOUR_MS)
    },
    { id: SnoozePresetId.TOMORROW_MORNING, until: instantAt(addDays(morning, 1), timezone) },
    { id: SnoozePresetId.NEXT_WEEK, until: instantAt(addDays(morning, daysToMonday), timezone) }
  ]
}

// What the "pick a date" field holds: `YYYY-MM-DDTHH:mm`, the wall clock of the store. Null when it
// is empty or not a date.
export function parseLocalDateTime(value: string, timezone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null
  }
  const calendar = new Date(Date.UTC(year, month - 1, day))
  const isRealDate =
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    hour < 24 &&
    minute < 60
  return isRealDate ? instantAt({ year, month, day, hour, minute }, timezone) : null
}

// The same wall clock as the value of a `datetime-local` field, for its `min`
export function toLocalDateTimeValue(instant: Date, timezone: string): string {
  const clock = wallClockIn(instant, timezone)
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0')
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}T${pad(clock.hour)}:${pad(clock.minute)}`
}
