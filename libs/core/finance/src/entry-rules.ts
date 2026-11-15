import {
  EntryOrigin,
  FinanceCurrency,
  FinanceLimits,
  JournalEntryType,
  type FinanceSourceType,
  type PartyType
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

// The pure rules of a journal entry (TDD_18 §4.1): what makes an entry valid before the database sees it. The posting
// service builds a draft, asks this file whether it is valid and only then writes it; the database holds the same
// rules (balanced at commit, one side per line, open period) as the net under a bug of the service.

export interface DraftLine {
  accountId: string
  debitCents: number
  creditCents: number
  // The dimension of the line (the store of the order, the warehouse's owner, the store of the expense)
  storeId?: string | null
  partyType?: PartyType | null
  partyId?: string | null
  taxRateId?: string | null
  memo?: string | null
}

export interface DraftEntry {
  // The accounting date, 'YYYY-MM-DD': it decides the period
  entryDate: string
  type: JournalEntryType
  sourceType?: FinanceSourceType | null
  sourceId?: string | null
  sourceDate?: string | null
  idempotencyKey: string
  memo?: string | null
  currency?: string
  origin: EntryOrigin
  lines: readonly DraftLine[]
}

export interface EntryProblem {
  code:
    | typeof ErrorCodes.FINANCE_ENTRY_UNBALANCED
    | typeof ErrorCodes.FINANCE_CURRENCY_UNSUPPORTED
    | typeof ErrorCodes.VALIDATION_INVALID_INPUT
  // A short, stable name of the broken rule: for the log and the tests, never shown to a person
  rule: string
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

// A calendar date, not only a shape that looks like one (no 31 of February)
export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

const isWholeCents = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= FinanceLimits.MAX_LINE_CENTS

export function totalsOf(lines: readonly DraftLine[]): { debitCents: number; creditCents: number } {
  let debitCents = 0
  let creditCents = 0
  for (const line of lines) {
    debitCents += line.debitCents
    creditCents += line.creditCents
  }
  return { debitCents, creditCents }
}

// Every rule an entry must keep, all of them reported (a person fixing a manual entry sees what is wrong at once).
// An empty list is a valid entry. Amounts are whole cents: a float, a negative or a cent beyond the Int of the
// database is refused here, so the balance below is exact.
export function validateDraftEntry(entry: DraftEntry): EntryProblem[] {
  const problems: EntryProblem[] = []
  // Only the rules about the amounts are the entry not balancing; the rest is an input that is not valid
  const unbalanced = (rule: string): void => {
    problems.push({ code: ErrorCodes.FINANCE_ENTRY_UNBALANCED, rule })
  }
  const invalid = (rule: string): void => {
    problems.push({ code: ErrorCodes.VALIDATION_INVALID_INPUT, rule })
  }

  if ((entry.currency ?? FinanceCurrency) !== FinanceCurrency) {
    problems.push({ code: ErrorCodes.FINANCE_CURRENCY_UNSUPPORTED, rule: 'currency' })
  }
  if (!isIsoDate(entry.entryDate)) invalid('entry_date')
  if (entry.sourceDate !== undefined && entry.sourceDate !== null && !isIsoDate(entry.sourceDate)) {
    invalid('source_date')
  }
  if (
    entry.idempotencyKey.length === 0 ||
    entry.idempotencyKey.length > FinanceLimits.IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    invalid('idempotency_key')
  }
  // A manual entry says why: it is the accountant's adjustment, and the auditor reads the memo (TDD_18 §4.2, E13)
  const memo = entry.memo?.trim() ?? ''
  if (entry.type === JournalEntryType.MANUAL && memo.length === 0) invalid('memo_required')
  if (memo.length > FinanceLimits.MEMO_MAX_LENGTH) invalid('memo_length')
  // The system has no user: it says so by origin, and a manual entry is always a person's
  if (entry.type === JournalEntryType.MANUAL && entry.origin !== EntryOrigin.USER) {
    invalid('manual_by_user')
  }

  if (entry.lines.length < 2) unbalanced('at_least_two_lines')
  if (entry.lines.length > FinanceLimits.MAX_LINES_PER_ENTRY) invalid('too_many_lines')

  let wholeCents = true
  for (const line of entry.lines) {
    if (!isWholeCents(line.debitCents) || !isWholeCents(line.creditCents)) {
      wholeCents = false
      unbalanced('whole_cents')
      break
    }
    // One side per line, and it is positive: the CHECK of the table says the same
    if (line.debitCents > 0 === line.creditCents > 0) {
      unbalanced('one_side_per_line')
      break
    }
  }
  if (wholeCents) {
    const { debitCents, creditCents } = totalsOf(entry.lines)
    if (debitCents !== creditCents) unbalanced('debits_equal_credits')
    // The total of an entry is an Int of the database (JournalEntry.totalCents)
    if (debitCents > FinanceLimits.MAX_LINE_CENTS) unbalanced('total_too_large')
    if (debitCents === 0) unbalanced('total_positive')
  }
  return problems
}

// The reversing entry of an entry (TDD_18 §2.5): the same lines with the sides swapped, so every account returns to
// where it was. The original is never touched: the reversal points at it (`reversesEntryId`, set by the service).
export function reverseLines(lines: readonly DraftLine[]): DraftLine[] {
  return lines.map(line => ({
    ...line,
    debitCents: line.creditCents,
    creditCents: line.debitCents
  }))
}

// The balance of one account over some lines, on its normal side: a positive number is a balance where the account
// grows. `debitNormal` is true for asset, cost of sales and expense accounts.
export function balanceOf(
  debitCents: bigint | number,
  creditCents: bigint | number,
  debitNormal: boolean
): bigint {
  const net = BigInt(debitCents) - BigInt(creditCents)
  return debitNormal ? net : -net
}
