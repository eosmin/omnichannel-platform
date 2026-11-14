const MINUTE = 60
const HOUR = 3600
const DAY = 86_400

type Unit = 'day' | 'hour' | 'minute' | 'second'

// The two biggest units that are not zero, whole ("2 h 18 min", "3 min 42 s", "45 s"): a time of a day does not need its
// seconds. Null for a number that is not a time.
export function durationParts(seconds: number): { unit: Unit; value: number }[] | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const total = Math.round(seconds)
  const days = Math.floor(total / DAY)
  const hours = Math.floor((total % DAY) / HOUR)
  const minutes = Math.floor((total % HOUR) / MINUTE)
  const rest = total % MINUTE
  const parts: { unit: Unit; value: number }[] = [
    { unit: 'day', value: days },
    { unit: 'hour', value: hours },
    { unit: 'minute', value: minutes },
    { unit: 'second', value: rest }
  ]
  const first = parts.findIndex(part => part.value > 0)
  if (first === -1) return [{ unit: 'second', value: 0 }]
  return parts.slice(first, first + 2).filter(part => part.value > 0)
}

// The words of the units come from the runtime in the language of the person ("min", "h"): the app writes none of them
export function formatDuration(seconds: number, locale: string): string | null {
  const parts = durationParts(seconds)
  if (parts === null) return null
  return parts
    .map(part =>
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: part.unit,
        unitDisplay: 'narrow',
        maximumFractionDigits: 0
      }).format(part.value)
    )
    .join(' ')
}
