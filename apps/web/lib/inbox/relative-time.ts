const UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: 'year', seconds: 31_556_952 },
  { unit: 'month', seconds: 2_629_746 },
  { unit: 'week', seconds: 604_800 },
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 }
]

// "5 min ago" in the language of the interface. Under a minute is "now" (numeric: auto), so a row
// does not change its text every second.
export function relativeTime(from: Date, now: Date, locale: string): string {
  // A clock that runs behind the server's puts a message in the future: that is still "now"
  const seconds = Math.min(0, Math.round((from.getTime() - now.getTime()) / 1000))
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
  const found = UNITS.find(({ seconds: size }) => Math.abs(seconds) >= size)
  if (found === undefined) return formatter.format(0, 'second')
  return formatter.format(Math.trunc(seconds / found.seconds), found.unit)
}
