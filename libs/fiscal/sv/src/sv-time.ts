// The authority works in the time of El Salvador, which is UTC-6 all year (there is no daylight saving). A document carries the date and
// the hour of its generation in that time.
// Hours El Salvador is behind UTC, all year
export const SALVADOR_OFFSET_HOURS = 6
const OFFSET_MS = SALVADOR_OFFSET_HOURS * 60 * 60 * 1000

export interface SalvadorMoment {
  // yyyy-MM-dd
  readonly date: string
  // HH:mm:ss
  readonly time: string
}

export function salvadorMoment(iso: string): SalvadorMoment {
  const instant = new Date(iso).getTime()
  if (Number.isNaN(instant)) throw new RangeError('not an instant')
  const text = new Date(instant - OFFSET_MS).toISOString()
  return { date: text.slice(0, 10), time: text.slice(11, 19) }
}
