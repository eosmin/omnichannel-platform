'use client'

import { useFormatter } from 'next-intl'

// A day of the store ('YYYY-MM-DD') as text: built at UTC and written at UTC, so the day never moves with the zone of the
// person (it is a calendar day, not a moment)
export function useDayText(): (day: string) => string {
  const format = useFormatter()
  return day =>
    format.dateTime(new Date(`${day}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
}
