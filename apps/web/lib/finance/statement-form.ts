import type { AgingKind } from '@platform/core/domain'

import { dayOfClock, isCalendarDay } from './dates'

// The forms of the statements and the lists with age (Step 4B.9b-3). Each says what is wrong before it asks the api, with the same rules
// the api applies (a spec runs every query through the schema of the api). A statement is a sum, not a file of rows, so a range has no
// length limit; the CSV of a statement is the same question asked as a file.

export const StatementRangeProblems = {
  FROM: 'from',
  TO: 'to',
  ORDER: 'order'
} as const
export type StatementRangeProblem =
  (typeof StatementRangeProblems)[keyof typeof StatementRangeProblems]

export interface StatementRangeDraft {
  from: string
  to: string
}

export function statementRangeProblem(draft: StatementRangeDraft): StatementRangeProblem | null {
  const from = draft.from.trim()
  const to = draft.to.trim()
  if (!isCalendarDay(from)) return StatementRangeProblems.FROM
  if (!isCalendarDay(to)) return StatementRangeProblems.TO
  return from > to ? StatementRangeProblems.ORDER : null
}

// The day of a statement of one day: a real calendar day or nothing
export const statementDayProblem = (day: string): boolean => !isCalendarDay(day.trim())

// The question of a range: call only after `statementRangeProblem` said null
export const flowQueryOf = (draft: StatementRangeDraft): { from: string; to: string } => ({
  from: draft.from.trim(),
  to: draft.to.trim()
})

export const balanceSheetQueryOf = (day: string): { asOf: string } => ({ asOf: day.trim() })

export const agingQueryOf = (kind: AgingKind, day: string): { kind: AgingKind; asOf: string } => ({
  kind,
  asOf: day.trim()
})

// What a statement starts from: the month so far for a range, today for a day
export function defaultRange(clock: Date): StatementRangeDraft {
  const today = dayOfClock(clock)
  return { from: `${today.slice(0, 8)}01`, to: today }
}

// The names a downloaded statement takes: readable ones (the api names them the same way; the page saves what the person asked for)
export const flowFileName = (report: string, query: { from: string; to: string }): string =>
  `${report}-${query.from}-${query.to}.csv`
export const dayFileName = (report: string, day: string): string => `${report}-${day}.csv`
