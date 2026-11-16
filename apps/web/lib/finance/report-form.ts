import {
  FinanceLimits,
  FinanceReportLimits,
  hasMisleadingCharacters,
  plainName
} from '@platform/core/domain'

import { isCalendarDay } from './dates'
import { periodKeyOf } from './period-form'

// The forms of the reports and of the reopen of a month (Step 4B.9b-1). Each says what is wrong before it asks the api, with the same
// rules the api applies (a spec runs every payload through the schema of the api).

export const ReportRangeProblems = {
  FROM: 'from',
  TO: 'to',
  ORDER: 'order',
  LENGTH: 'length'
} as const
export type ReportRangeProblem = (typeof ReportRangeProblems)[keyof typeof ReportRangeProblems]

export interface ReportRangeDraft {
  from: string
  to: string
}

const DAY_MS = 86_400_000
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`)

// A file covers a range with both ends; the ledger on screen may leave either end open
export function reportRangeProblem(
  draft: ReportRangeDraft,
  { bothEnds }: { bothEnds: boolean }
): ReportRangeProblem | null {
  const from = draft.from.trim()
  const to = draft.to.trim()
  if (from === '' ? bothEnds : !isCalendarDay(from)) return ReportRangeProblems.FROM
  if (to === '' ? bothEnds : !isCalendarDay(to)) return ReportRangeProblems.TO
  if (from === '' || to === '') return null
  if (from > to) return ReportRangeProblems.ORDER
  return (dayStart(to) - dayStart(from)) / DAY_MS >= FinanceReportLimits.CSV_MAX_RANGE_DAYS &&
    bothEnds
    ? ReportRangeProblems.LENGTH
    : null
}

export const journalCsvInputOf = (draft: ReportRangeDraft): { from: string; to: string } => ({
  from: draft.from.trim(),
  to: draft.to.trim()
})

export const ledgerCsvInputOf = (
  accountId: string,
  draft: ReportRangeDraft
): { accountId: string; from: string; to: string } => ({ accountId, ...journalCsvInputOf(draft) })

// The first page of the ledger: a blank end is no end
export const ledgerQueryOf = (
  accountId: string,
  draft: ReportRangeDraft
): { accountId: string; from: string | null; to: string | null } => ({
  accountId,
  from: draft.from.trim() === '' ? null : draft.from.trim(),
  to: draft.to.trim() === '' ? null : draft.to.trim()
})

export const ReopenReasonProblems = {
  EMPTY: 'empty',
  TOO_LONG: 'tooLong',
  INVALID: 'invalid'
} as const
export type ReopenReasonProblem = (typeof ReopenReasonProblems)[keyof typeof ReopenReasonProblems]

export function reopenReasonProblem(reason: string): ReopenReasonProblem | null {
  const text = reason.trim()
  if (text === '') return ReopenReasonProblems.EMPTY
  if (text.length > FinanceLimits.REOPEN_REASON_MAX_LENGTH) return ReopenReasonProblems.TOO_LONG
  return hasMisleadingCharacters(plainName(text)) ? ReopenReasonProblems.INVALID : null
}

// Call only after `reopenReasonProblem` said null
export const reopenInputOf = (reason: string): { reason: string } => ({ reason: reason.trim() })

// What the person types to close a month: its own name, 'YYYY-MM', which the screen shows beside the effect
export const closePhraseOf = (period: { year: number; month: number }): string =>
  periodKeyOf(period)

export const closePhraseMatches = (
  typed: string,
  period: { year: number; month: number }
): boolean => typed.trim() === closePhraseOf(period)

// The names a downloaded file takes: readable ones (the api names the trial balance by the id of the period)
export const trialBalanceFileName = (period: { year: number; month: number }): string =>
  `trial-balance-${closePhraseOf(period)}.csv`
export const ledgerFileName = (code: string, draft: ReportRangeDraft): string =>
  `ledger-${code}-${draft.from.trim()}-${draft.to.trim()}.csv`
export const journalFileName = (draft: ReportRangeDraft): string =>
  `journal-${draft.from.trim()}-${draft.to.trim()}.csv`
