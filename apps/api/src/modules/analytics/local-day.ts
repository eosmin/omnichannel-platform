import { isTimezone } from '@platform/core/domain'

// The instant a calendar day starts in a time zone, for "today" of one person's figures (the My performance
// widget). The rollup tables keep UTC days; a widget that says "today" must not flip at 18:00 of the store.
type DatePart = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'

// How far the wall clock of the zone is ahead of UTC at an instant, in milliseconds
function offsetAt(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(at)
  const value = (type: DatePart): number =>
    Number(parts.find(part => part.type === type)?.value ?? 0)
  const wall = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second')
  )
  return wall - Math.floor(at.getTime() / 1000) * 1000
}

// A missing or unknown zone counts as UTC: the figures are then of the UTC day, never an error
export function startOfDayIn(timeZone: string | null | undefined, now: Date): Date {
  const zone =
    timeZone !== null && timeZone !== undefined && isTimezone(timeZone) ? timeZone : 'UTC'
  const wallNow = new Date(now.getTime() + offsetAt(zone, now))
  const wallMidnight = Date.UTC(
    wallNow.getUTCFullYear(),
    wallNow.getUTCMonth(),
    wallNow.getUTCDate()
  )
  // The offset can differ at midnight from the one of now (a change of daylight saving that day): look it up again
  const guess = new Date(wallMidnight - offsetAt(zone, now))
  return new Date(wallMidnight - offsetAt(zone, guess))
}
