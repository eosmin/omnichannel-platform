const HOURS_PER_DAY = 24

interface LocalParts {
  year: string
  month: string
  day: string
  hour: number
}

// One formatter for each zone, made once: the hourly scheduler asks about every store, and a few hundred zones are all there are
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

// The hour and the day of the zone at `now`, from one reading, or null for a zone that is not one
export function localClockOf(now: Date, timeZone: string): { hour: number; day: string } | null {
  const parts = localParts(now, timeZone)
  return parts === null
    ? null
    : { hour: parts.hour, day: `${parts.year}-${parts.month}-${parts.day}` }
}

function localParts(now: Date, timeZone: string): LocalParts | null {
  try {
    const parts = formatterOf(timeZone).formatToParts(now)
    const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    // h23 reads 00..23; some engines still write 24 for midnight
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: Number(get('hour')) % HOURS_PER_DAY
    }
  } catch {
    // A zone this engine does not know: the store is skipped (and the scheduler says so), never run at a guessed hour
    return null
  }
}

// The hour (0-23) the clock of the zone reads at `now`, or null for a zone that is not one
export function localHourOf(now: Date, timeZone: string): number | null {
  return localParts(now, timeZone)?.hour ?? null
}

// "2026-11-14": the calendar day of the zone at `now`, which names the run of that day
export function localDayOf(now: Date, timeZone: string): string | null {
  const parts = localParts(now, timeZone)
  return parts === null ? null : `${parts.year}-${parts.month}-${parts.day}`
}

// The first instant of the UTC calendar month that holds `at`
export function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
}

export function startOfNextUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
}
