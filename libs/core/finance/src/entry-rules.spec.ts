import { EntryOrigin, FinanceLimits, JournalEntryType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import {
  balanceOf,
  type DraftEntry,
  type DraftLine,
  isIsoDate,
  reverseLines,
  totalsOf,
  validateDraftEntry
} from './entry-rules'

const debit = (accountId: string, cents: number): DraftLine => ({
  accountId,
  debitCents: cents,
  creditCents: 0
})
const credit = (accountId: string, cents: number): DraftLine => ({
  accountId,
  debitCents: 0,
  creditCents: cents
})

const entry = (overrides: Partial<DraftEntry> = {}): DraftEntry => ({
  entryDate: '2026-11-15',
  type: JournalEntryType.EXPENSE,
  idempotencyKey: 'transaction:1:record',
  origin: EntryOrigin.SYSTEM,
  lines: [debit('a', 1000), credit('b', 1000)],
  ...overrides
})

const rules = (draft: DraftEntry): string[] => validateDraftEntry(draft).map(p => p.rule)

describe('isIsoDate', () => {
  it.each(['2026-11-15', '2024-02-29', '2026-12-31'])('accepts %s', value => {
    expect(isIsoDate(value)).toBe(true)
  })
  it.each([
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-11-31',
    '26-11-15',
    '2026-11-15T00:00',
    ''
  ])('refuses %s', value => {
    expect(isIsoDate(value)).toBe(false)
  })
})

describe('validateDraftEntry', () => {
  it('accepts a balanced entry', () => {
    expect(validateDraftEntry(entry())).toEqual([])
  })

  it('refuses an entry that does not balance, with the code of an unbalanced entry', () => {
    const problems = validateDraftEntry(entry({ lines: [debit('a', 1000), credit('b', 999)] }))
    expect(problems).toEqual([
      { code: ErrorCodes.FINANCE_ENTRY_UNBALANCED, rule: 'debits_equal_credits' }
    ])
  })

  it('refuses fewer than two lines', () => {
    expect(rules(entry({ lines: [debit('a', 5)] }))).toContain('at_least_two_lines')
    expect(rules(entry({ lines: [] }))).toContain('at_least_two_lines')
  })

  it('refuses a line with both sides, with neither, a negative one, a float and a cent beyond the Int', () => {
    const both: DraftLine = { accountId: 'a', debitCents: 5, creditCents: 5 }
    const neither: DraftLine = { accountId: 'a', debitCents: 0, creditCents: 0 }
    expect(rules(entry({ lines: [both, credit('b', 5)] }))).toContain('one_side_per_line')
    expect(rules(entry({ lines: [neither, credit('b', 5)] }))).toContain('one_side_per_line')
    expect(rules(entry({ lines: [debit('a', -5), credit('b', -5)] }))).toContain('whole_cents')
    expect(rules(entry({ lines: [debit('a', 1.5), credit('b', 1.5)] }))).toContain('whole_cents')
    expect(
      rules(entry({ lines: [debit('a', FinanceLimits.MAX_LINE_CENTS + 1), credit('b', 1)] }))
    ).toContain('whole_cents')
    expect(rules(entry({ lines: [debit('a', Number.NaN), credit('b', 1)] }))).toContain(
      'whole_cents'
    )
  })

  it('refuses a total beyond the Int of JournalEntry.totalCents', () => {
    const half = FinanceLimits.MAX_LINE_CENTS
    const lines = [debit('a', half), debit('b', 1), credit('c', half), credit('d', 1)]
    expect(rules(entry({ lines }))).toContain('total_too_large')
  })

  it('refuses more lines than the limit', () => {
    const lines = Array.from({ length: FinanceLimits.MAX_LINES_PER_ENTRY + 1 }, (_, index) =>
      index % 2 === 0 ? debit('a', 1) : credit('b', 1)
    )
    expect(rules(entry({ lines }))).toContain('too_many_lines')
  })

  it('refuses a currency that is not USD', () => {
    expect(validateDraftEntry(entry({ currency: 'COP' }))).toEqual([
      { code: ErrorCodes.FINANCE_CURRENCY_UNSUPPORTED, rule: 'currency' }
    ])
  })

  it('refuses a bad date, a bad source date and a bad key', () => {
    expect(rules(entry({ entryDate: '2026-02-30' }))).toContain('entry_date')
    expect(rules(entry({ sourceDate: 'yesterday' }))).toContain('source_date')
    expect(rules(entry({ sourceDate: '2026-11-01' }))).toEqual([])
    expect(rules(entry({ idempotencyKey: '' }))).toContain('idempotency_key')
    expect(
      rules(entry({ idempotencyKey: 'x'.repeat(FinanceLimits.IDEMPOTENCY_KEY_MAX_LENGTH + 1) }))
    ).toContain('idempotency_key')
  })

  it('wants a memo on a manual entry, made by a person', () => {
    const manual = { type: JournalEntryType.MANUAL, origin: EntryOrigin.USER }
    expect(rules(entry(manual))).toContain('memo_required')
    expect(rules(entry({ ...manual, memo: '   ' }))).toContain('memo_required')
    expect(rules(entry({ ...manual, memo: 'adjustment' }))).toEqual([])
    expect(
      rules(entry({ type: JournalEntryType.MANUAL, origin: EntryOrigin.SYSTEM, memo: 'x' }))
    ).toContain('manual_by_user')
  })

  it('keeps a memo within its length', () => {
    expect(rules(entry({ memo: 'x'.repeat(FinanceLimits.MEMO_MAX_LENGTH + 1) }))).toContain(
      'memo_length'
    )
  })

  it('reports every broken rule at once', () => {
    const found = rules(entry({ entryDate: 'x', lines: [debit('a', 1)] }))
    expect(found).toEqual(
      expect.arrayContaining(['entry_date', 'at_least_two_lines', 'debits_equal_credits'])
    )
  })

  it('refuses a total of zero', () => {
    // Both sides positive per line is the rule above; an entry of only zero lines never reaches the total
    expect(rules(entry({ lines: [debit('a', 0), credit('b', 0)] }))).toContain('one_side_per_line')
  })
})

describe('reverseLines and totalsOf', () => {
  it('swaps the sides of every line and keeps the rest', () => {
    const lines: DraftLine[] = [
      { ...debit('a', 700), storeId: 's', partyType: null },
      { ...credit('b', 700), memo: 'm' }
    ]
    const reversed = reverseLines(lines)
    expect(reversed[0]).toMatchObject({
      accountId: 'a',
      debitCents: 0,
      creditCents: 700,
      storeId: 's'
    })
    expect(reversed[1]).toMatchObject({
      accountId: 'b',
      debitCents: 700,
      creditCents: 0,
      memo: 'm'
    })
    expect(validateDraftEntry(entry({ lines: reversed }))).toEqual([])
    expect(totalsOf(reversed)).toEqual(totalsOf(lines))
  })
})

describe('balanceOf', () => {
  it('is positive where the account grows', () => {
    expect(balanceOf(1000, 400, true)).toBe(600n)
    expect(balanceOf(400, 1000, false)).toBe(600n)
    expect(balanceOf(400, 1000, true)).toBe(-600n)
  })
  it('does not lose cents past 32 bits', () => {
    expect(balanceOf(9_000_000_000n, 1n, true)).toBe(8_999_999_999n)
  })
})
