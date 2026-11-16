import type { ManualFinanceEntryInput } from '@platform/api-client'
import { FinanceLimits, JournalEntryType } from '@platform/core/domain'

import { isCalendarDay } from './dates'
import { positiveCentsOfDecimalText } from './money'

// The form of an entry a person writes (TDD_18 §4.2, E13): free lines that balance, and the reason. The amounts are typed as dollars
// and sent as whole cents; a line takes one side, so a line with both sides filled is a mistake the form names, not one it fixes.
export interface ManualLineDraft {
  // The identity of the row on the screen (not sent): a line removed from the middle keeps the others' fields
  key: string
  accountId: string
  debit: string
  credit: string
  memo: string
}

export interface ManualEntryDraft {
  entryDate: string
  type: string
  memo: string
  lines: ManualLineDraft[]
}

export const ManualEntryEntryTypes = [
  JournalEntryType.MANUAL,
  JournalEntryType.OPENING_BALANCE
] as const

export const ManualEntryFields = {
  DATE: 'date',
  MEMO: 'memo',
  LINES: 'lines',
  LINE: 'line',
  BALANCE: 'balance',
  TOTAL: 'total'
} as const
export type ManualEntryField = (typeof ManualEntryFields)[keyof typeof ManualEntryFields]

export interface ManualEntryProblem {
  field: ManualEntryField
  // The line that is wrong, from 0, for the problems of one line
  index: number | null
}

export const newManualLine = (key: string): ManualLineDraft => ({
  key,
  accountId: '',
  debit: '',
  credit: '',
  memo: ''
})

export const emptyManualEntryDraft = (today: string, keys: [string, string]): ManualEntryDraft => ({
  entryDate: today,
  type: JournalEntryType.MANUAL,
  memo: '',
  lines: [newManualLine(keys[0]), newManualLine(keys[1])]
})

// The cents of one side of a line: nothing typed is 0, a typed amount that is not one is null
// An empty side and a typed zero ("0", "0.00") are both nothing: a person fills one side and may write 0 on the other
const sideOf = (text: string): number | null =>
  text.trim() === '' || /^0+(?:[.,]0{1,2})?$/.test(text.trim())
    ? 0
    : positiveCentsOfDecimalText(text)

// The request schema of the api counts a memo in UTF-16 units (zod `max`), which is stricter than the database's code points: the
// form takes the stricter, so a memo the form accepts is one the api accepts
const lengthOf = (text: string): number => text.length

export interface ManualEntryTotals {
  debitCents: number
  creditCents: number
}

// What the lines add up to on each side, for the footer of the form (a side that cannot be read counts as 0: the problem names it)
export function manualEntryTotals(lines: readonly ManualLineDraft[]): ManualEntryTotals {
  let debitCents = 0
  let creditCents = 0
  for (const line of lines) {
    debitCents += sideOf(line.debit) ?? 0
    creditCents += sideOf(line.credit) ?? 0
  }
  return { debitCents, creditCents }
}

export function manualEntryProblem(draft: ManualEntryDraft): ManualEntryProblem | null {
  if (!isCalendarDay(draft.entryDate)) return { field: ManualEntryFields.DATE, index: null }
  const memo = draft.memo.trim()
  if (memo === '' || lengthOf(memo) > FinanceLimits.MEMO_MAX_LENGTH) {
    return { field: ManualEntryFields.MEMO, index: null }
  }
  if (draft.lines.length < 2 || draft.lines.length > FinanceLimits.MAX_LINES_PER_ENTRY) {
    return { field: ManualEntryFields.LINES, index: null }
  }
  for (const [index, line] of draft.lines.entries()) {
    const debit = sideOf(line.debit)
    const credit = sideOf(line.credit)
    const oneSide = debit !== null && credit !== null && debit > 0 !== credit > 0
    if (
      line.accountId === '' ||
      !oneSide ||
      lengthOf(line.memo.trim()) > FinanceLimits.MEMO_MAX_LENGTH
    ) {
      return { field: ManualEntryFields.LINE, index }
    }
  }
  const totals = manualEntryTotals(draft.lines)
  if (totals.debitCents !== totals.creditCents)
    return { field: ManualEntryFields.BALANCE, index: null }
  // The api refuses an entry whose total is more than a line can hold (a sum of lines passes the 32 bits of one)
  if (totals.debitCents > FinanceLimits.MAX_LINE_CENTS) {
    return { field: ManualEntryFields.TOTAL, index: null }
  }
  return null
}

// Call only after `manualEntryProblem` said null
export function manualEntryInputOf(
  draft: ManualEntryDraft,
  idempotencyKey: string
): ManualFinanceEntryInput {
  return {
    idempotencyKey,
    entryDate: draft.entryDate,
    type: draft.type,
    memo: draft.memo.trim(),
    lines: draft.lines.map(line => ({
      accountId: line.accountId,
      debitCents: sideOf(line.debit) ?? 0,
      creditCents: sideOf(line.credit) ?? 0,
      ...(line.memo.trim() === '' ? {} : { memo: line.memo.trim() })
    }))
  }
}
