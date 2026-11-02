export interface QuietHoursRange {
  start: number // 0-23, on the clock of `timezone`
  end: number // 0-23
  timezone: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

// The hour (0-23) on the clock of a timezone, daylight saving included
export function hourIn(timezone: string, at: Date): number {
  let formatter = formatters.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23'
    })
    formatters.set(timezone, formatter)
  }
  const hour = formatter.formatToParts(at).find(part => part.type === 'hour')?.value
  return Number(hour) % 24
}

// Whether a moment falls inside quiet hours (TDD_06 §6.3). A range holds its start and not its end,
// and one that crosses midnight (22 to 7) wraps. Equal start and end is an empty range, not a whole day.
export function isInQuietRange(range: QuietHoursRange, at: Date): boolean {
  if (range.start === range.end) return false
  const hour = hourIn(range.timezone, at)
  return range.start > range.end
    ? hour >= range.start || hour < range.end
    : hour >= range.start && hour < range.end
}
