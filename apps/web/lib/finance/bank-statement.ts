import {
  ApiError,
  type BankBookCandidateView,
  type BankLineView,
  type BankRowErrorView,
  type BankSuggestionView,
  type FinanceAccountView,
  type ImportBankFileInput
} from '@platform/api-client'
import {
  BankLineFilters,
  BankStatementLimits,
  FinanceConflicts,
  FinanceLimits,
  groupProblems
} from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import { cashAccountsOf } from './account-form'
import { isCalendarDay } from './dates'
import { centsOfDecimalText } from './money'

// The pure part of the bank reconciliation screen (TDD_18 §4.4): which accounts a statement can be imported for, the import form, how
// the answers of the api are read back and why a suggestion is a suggestion. The parsing, the matching and every rule on the books are
// the api's: nothing here decides that a line is reconciled.

// The accounts a bank profile and a statement can be of: the ones the api takes (an account that is cash, a bank or a wallet), that
// post and are on. The one already chosen stays in the list, so a select never shows an empty choice for a value it holds.
export function bankAccountsOf(
  accounts: readonly FinanceAccountView[],
  keep: readonly string[]
): FinanceAccountView[] {
  return cashAccountsOf(accounts, keep)
}

// ------------------------------------------------------------------------------------------------------ the import form

export interface BankImportDraft {
  profileId: string
  // The balance the statement ends with, as typed, and the day it is of: both or neither
  closingBalance: string
  closingOn: string
  // The person confirmed the order of the day and the month of the file (asked when every date of it reads in both orders)
  dateFormatConfirmed?: boolean
}

export const emptyImportDraft = (profileId = ''): BankImportDraft => ({
  profileId,
  closingBalance: '',
  closingOn: ''
})

export const BankImportFields = {
  PROFILE: 'profile',
  FILE: 'file',
  CLOSING_BALANCE: 'closingBalance',
  CLOSING_ON: 'closingOn'
} as const
export type BankImportField = (typeof BankImportFields)[keyof typeof BankImportFields]

export type BankImportResult =
  { ok: true; value: ImportBankFileInput } | { ok: false; field: BankImportField }

// The request of an import: the file as text (the browser decoded it with the encoding of the profile) and, when the person knows it,
// the closing balance with its day. A balance with no day, or a day with no balance, is the api's 400, so the form says it first.
export function importInputOf(
  draft: BankImportDraft,
  file: { bytes: ArrayBuffer; contentType: string } | null
): BankImportResult {
  if (draft.profileId === '') return { ok: false, field: BankImportFields.PROFILE }
  if (file === null) return { ok: false, field: BankImportFields.FILE }
  const balance = draft.closingBalance.trim()
  const day = draft.closingOn.trim()
  const confirmed = draft.dateFormatConfirmed === true ? { dateFormatConfirmed: true } : {}
  if (balance === '' && day === '') {
    return { ok: true, value: { profileId: draft.profileId, ...file, ...confirmed } }
  }
  const cents = centsOfDecimalText(balance, FinanceLimits.MAX_LINE_CENTS)
  if (cents === null) return { ok: false, field: BankImportFields.CLOSING_BALANCE }
  if (!isCalendarDay(day)) return { ok: false, field: BankImportFields.CLOSING_ON }
  return {
    ok: true,
    value: { profileId: draft.profileId, ...file, closing: { cents, on: day }, ...confirmed }
  }
}

// ------------------------------------------------------------------------------------------------------ the answers

// The row errors a refused statement carries (`metadata.errors`, bounded by the api). Anything that is not a row with a code is left
// out, so a changed shape shows fewer rows and never breaks the page.
export function bankImportErrorsOf(
  error: unknown
): { errors: BankRowErrorView[]; count: number } | null {
  if (!(error instanceof ApiError) || error.code !== ClientErrorCodes.BANK_STATEMENT_INVALID) {
    return null
  }
  const raw: unknown = error.metadata.errors
  const errors = (Array.isArray(raw) ? raw : []).flatMap((entry: unknown): BankRowErrorView[] => {
    const row = entry as Partial<BankRowErrorView> | null
    if (typeof row?.row !== 'number' || typeof row.code !== 'string') return []
    return [
      {
        row: row.row,
        field: typeof row.field === 'string' ? row.field : null,
        code: row.code,
        value: typeof row.value === 'string' ? row.value : null
      }
    ]
  })
  const count = error.metadata.errorCount
  return { errors, count: typeof count === 'number' ? count : errors.length }
}

// The 409 that asks the person to confirm the order of the day and the month: the format of the profile and the days that were read
export function bankDateFormatPromptOf(
  error: unknown
): { dateFormat: string; firstDay: string; lastDay: string } | null {
  if (bankConflictOf(error) !== FinanceConflicts.BANK_DATE_FORMAT_UNCONFIRMED) return null
  const metadata = (error as ApiError).metadata
  const { dateFormat, firstDay, lastDay } = metadata
  return typeof dateFormat === 'string' &&
    typeof firstDay === 'string' &&
    typeof lastDay === 'string'
    ? { dateFormat, firstDay, lastDay }
    : null
}

// The kind of refusal of a 409 of the reconciliation (`metadata.conflict`, a lower-case word the api keeps in a closed list), or null
export function bankConflictOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== ClientErrorCodes.RESOURCE_CONFLICT) return null
  const conflict: unknown = error.metadata.conflict
  return typeof conflict === 'string' && /^[a-z_]{1,60}$/.test(conflict) ? conflict : null
}

// ------------------------------------------------------------------------------------------------------ the lines

export const LineStates = {
  MATCHED: 'matched',
  SUGGESTED: 'suggested',
  UNMATCHED: 'unmatched'
} as const
export type LineState = (typeof LineStates)[keyof typeof LineStates]

export function lineStateOf(line: BankLineView): LineState {
  if (line.match !== null) return LineStates.MATCHED
  return line.suggestions.length > 0 ? LineStates.SUGGESTED : LineStates.UNMATCHED
}

export const LINE_FILTERS = [
  BankLineFilters.ALL,
  BankLineFilters.SUGGESTED,
  BankLineFilters.UNMATCHED,
  BankLineFilters.MATCHED
] as const

// Why the api suggests a pair, in the words of the rules it applies: the amount is always the same to the cent (it is how a candidate is
// found), and then the day and the reference
export const SuggestionReasons = {
  SAME_AMOUNT: 'sameAmount',
  SAME_DAY: 'sameDay',
  DAYS_APART: 'daysApart',
  REFERENCE: 'reference'
} as const
export type SuggestionReason = (typeof SuggestionReasons)[keyof typeof SuggestionReasons]

export function reasonsOf(
  suggestion: Pick<BankSuggestionView, 'dayDifference' | 'referenceMatch'>
): { reason: SuggestionReason; days?: number }[] {
  return [
    { reason: SuggestionReasons.SAME_AMOUNT },
    suggestion.dayDifference === 0
      ? { reason: SuggestionReasons.SAME_DAY }
      : { reason: SuggestionReasons.DAYS_APART, days: suggestion.dayDifference },
    ...(suggestion.referenceMatch ? [{ reason: SuggestionReasons.REFERENCE }] : [])
  ]
}

// What a person has chosen for a group (HC-121), against the amount of the statement line: the signed sum of the chosen lines of the books
// and how far it is. The api decides (the same rule, `groupProblems`); this is only what the dialog shows while the person chooses, and
// it never lets a group go that the api would refuse for its shape or its sum.
export interface GroupSelection {
  chosen: number
  journalLineIds: string[]
  sumCents: number
  // statement minus chosen: positive when lines are missing, negative when there are too many
  differenceCents: number
  tooMany: boolean
  canConfirm: boolean
}

export function groupSelectionOf(
  statementCents: number,
  candidates: readonly BankBookCandidateView[],
  selected: ReadonlySet<string>
): GroupSelection {
  const picked = candidates.filter(candidate => selected.has(candidate.journalLineId))
  const lines = picked.map(candidate => ({
    id: candidate.journalLineId,
    signedCents: candidate.signedCents
  }))
  const sumCents = lines.reduce((total, each) => total + each.signedCents, 0)
  const problems = groupProblems({ statementCents, lines })
  return {
    chosen: picked.length,
    journalLineIds: lines.map(each => each.id),
    sumCents,
    differenceCents: statementCents - sumCents,
    tooMany: picked.length > BankStatementLimits.MAX_GROUP,
    canConfirm: problems.length === 0
  }
}

// The month the status of an account opens on: the one the day is in (UTC, like the periods)
export function monthOf(date: Date): { year: number; month: number } {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

export function monthProblem(year: string, month: string): 'year' | 'month' | null {
  if (!/^\d{4}$/.test(year.trim())) return 'year'
  const y = Number(year)
  if (y < FinanceLimits.MIN_YEAR || y > FinanceLimits.MAX_YEAR) return 'year'
  if (!/^\d{1,2}$/.test(month.trim())) return 'month'
  const m = Number(month)
  return m < FinanceLimits.FIRST_MONTH || m > FinanceLimits.LAST_MONTH ? 'month' : null
}
