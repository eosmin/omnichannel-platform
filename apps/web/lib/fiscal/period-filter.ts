import type { FiscalDocumentFilters } from '@platform/api-client'

import { isCalendarDay } from '../finance/dates'

// The period of the list of fiscal documents (Step 4B.9b-5c): the days a person writes become the two ends of the creation of the document,
// both included, in the person's own time zone.

export const PeriodProblems = {
  FROM: 'from',
  TO: 'to',
  ORDER: 'order'
} as const
export type PeriodProblem = (typeof PeriodProblems)[keyof typeof PeriodProblems]

export interface PeriodDraft {
  from: string
  to: string
}

// A day left empty is an open end; a day that is written must be a real one, and the first cannot come after the last
export function periodProblem(draft: PeriodDraft): PeriodProblem | null {
  const from = draft.from.trim()
  const to = draft.to.trim()
  if (from !== '' && !isCalendarDay(from)) return PeriodProblems.FROM
  if (to !== '' && !isCalendarDay(to)) return PeriodProblems.TO
  if (from !== '' && to !== '' && from > to) return PeriodProblems.ORDER
  return null
}

// The ends of the question: call only after `periodProblem` said null. The days are the person's own (the list shows each document at the hour
// of the person, so a document of "Nov 16" is found under Nov 16): the first end is the start of the first day and the last is the last
// millisecond of the last day, in the zone of the browser. A key left out is not a filter.
export function periodFiltersOf(draft: PeriodDraft): Pick<FiscalDocumentFilters, 'from' | 'to'> {
  const from = dayParts(draft.from.trim())
  const to = dayParts(draft.to.trim())
  return {
    ...(from === null ? {} : { from: new Date(from.year, from.month - 1, from.day).toISOString() }),
    ...(to === null
      ? {}
      : { to: new Date(new Date(to.year, to.month - 1, to.day + 1).getTime() - 1).toISOString() })
  }
}

function dayParts(text: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}
