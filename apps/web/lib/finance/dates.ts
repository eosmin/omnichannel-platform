// An accounting date is a day, 'YYYY-MM-DD', and a real one (no 31 of February): the api refuses anything else, and the form says so first
export function isCalendarDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

// The day of a clock as the books write it ('YYYY-MM-DD'), in the zone of the person: what a form suggests for "today"
export const dayOfClock = (clock: Date): string =>
  `${String(clock.getFullYear())}-${String(clock.getMonth() + 1).padStart(2, '0')}-${String(clock.getDate()).padStart(2, '0')}`

// The day after a day, by the calendar (no zone in it); the api accepts a transaction dated up to a day ahead of its own today
export function nextDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  const next = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (date ?? 1) + 1))
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}
