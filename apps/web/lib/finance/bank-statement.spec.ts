import { ApiError, type BankLineView, type FinanceAccountView } from '@platform/api-client'
import { BankStatementLimits, RemittanceImportLimits } from '@platform/core/domain'

import {
  bankAccountsOf,
  bankConflictOf,
  bankDateFormatPromptOf,
  bankImportErrorsOf,
  emptyImportDraft,
  importInputOf,
  lineStateOf,
  monthOf,
  monthProblem,
  reasonsOf
} from './bank-statement'

const account = (over: Partial<FinanceAccountView>): FinanceAccountView => ({
  id: 'a1',
  code: '1100',
  name: 'Bank',
  type: 'asset',
  normalSide: 'debit',
  parentId: null,
  isPostable: true,
  cashKind: 'bank',
  isSystem: false,
  active: true,
  currency: 'USD',
  createdAt: '2026-11-15T10:00:00.000Z',
  ...over
})

describe('the accounts a statement can be imported for', () => {
  it('offers only the cash, bank and wallet accounts that post and are on', () => {
    const accounts = [
      account({ id: 'bank', code: '1100' }),
      account({ id: 'cash', code: '1000', cashKind: 'cash' }),
      account({ id: 'receivable', code: '1200', cashKind: null }),
      account({ id: 'header', code: '1', isPostable: false }),
      account({ id: 'off', code: '1300', active: false })
    ]

    expect(bankAccountsOf(accounts, []).map(item => item.id)).toEqual(['cash', 'bank'])
  })

  it('keeps the one already chosen even when it was turned off since', () => {
    const accounts = [account({ id: 'off', active: false }), account({ id: 'bank', code: '1101' })]

    expect(bankAccountsOf(accounts, ['off']).map(item => item.id)).toContain('off')
  })
})

describe('the import form', () => {
  const file = {
    bytes: new TextEncoder().encode('Date,Amount\n2026-11-01,1.00').buffer,
    contentType: 'text/csv'
  }

  it('needs a profile and a file first', () => {
    expect(importInputOf(emptyImportDraft(), file)).toEqual({ ok: false, field: 'profile' })
    expect(importInputOf(emptyImportDraft('p1'), null)).toEqual({ ok: false, field: 'file' })
  })

  it('imports with no closing balance when none was given', () => {
    expect(importInputOf(emptyImportDraft('p1'), file)).toEqual({
      ok: true,
      value: { profileId: 'p1', ...file }
    })
  })

  it('sends the balance in whole cents with its day, never as a float', () => {
    const result = importInputOf(
      { profileId: 'p1', closingBalance: '1234,56', closingOn: '2026-11-30' },
      file
    )

    expect(result).toEqual({
      ok: true,
      value: { profileId: 'p1', ...file, closing: { cents: 123456, on: '2026-11-30' } }
    })
  })

  it('refuses the balance with no day, the day with no balance, an unreal day and a text that is no amount', () => {
    expect(importInputOf({ profileId: 'p1', closingBalance: '10', closingOn: '' }, file)).toEqual({
      ok: false,
      field: 'closingOn'
    })
    expect(
      importInputOf({ profileId: 'p1', closingBalance: '', closingOn: '2026-11-30' }, file)
    ).toEqual({
      ok: false,
      field: 'closingBalance'
    })
    expect(
      importInputOf({ profileId: 'p1', closingBalance: '10', closingOn: '2026-02-30' }, file)
    ).toEqual({
      ok: false,
      field: 'closingOn'
    })
    expect(
      importInputOf({ profileId: 'p1', closingBalance: '1,000.00', closingOn: '2026-11-30' }, file)
    ).toEqual({
      ok: false,
      field: 'closingBalance'
    })
  })

  it('reads the file with the same limit the api keeps', () => {
    // The screen decodes a statement with the limit of the remittance mapper: the two files are held to the same size
    expect(RemittanceImportLimits.MAX_BYTES).toBe(BankStatementLimits.MAX_BYTES)
    expect(RemittanceImportLimits.PREVIEW_MAX_BYTES).toBe(BankStatementLimits.PREVIEW_MAX_BYTES)
  })
})

describe('the answers of the api', () => {
  const invalid = (metadata: Record<string, unknown>): ApiError =>
    new ApiError(400, 'BANK_STATEMENT_INVALID', 'rows', 'corr', metadata)

  it('reads the row errors of a refused statement and drops what is not a row', () => {
    const issues = bankImportErrorsOf(
      invalid({
        errorCount: 120,
        errors: [
          { row: 2, field: 'amount', code: 'invalid_amount', value: 'abc' },
          { row: 3, field: null, code: 'empty_file', value: null },
          { field: 'date' },
          'nonsense'
        ]
      })
    )

    expect(issues?.count).toBe(120)
    expect(issues?.errors).toEqual([
      { row: 2, field: 'amount', code: 'invalid_amount', value: 'abc' },
      { row: 3, field: null, code: 'empty_file', value: null }
    ])
  })

  it('counts the rows it was given when the api sent no count', () => {
    expect(
      bankImportErrorsOf(invalid({ errors: [{ row: 1, field: null, code: 'x', value: null }] }))
        ?.count
    ).toBe(1)
  })

  it('is not about another error', () => {
    expect(bankImportErrorsOf(new ApiError(400, 'VALIDATION_FAILED', 'x', 'c', {}))).toBeNull()
    expect(bankImportErrorsOf(new Error('x'))).toBeNull()
  })

  it('sends that the person confirmed the order of the day and the month, only when they did', () => {
    const file = { bytes: new ArrayBuffer(4), contentType: 'text/csv' }
    expect(importInputOf({ ...emptyImportDraft('p1') }, file)).toEqual({
      ok: true,
      value: { profileId: 'p1', ...file }
    })
    expect(importInputOf({ ...emptyImportDraft('p1'), dateFormatConfirmed: true }, file)).toEqual({
      ok: true,
      value: { profileId: 'p1', ...file, dateFormatConfirmed: true }
    })
    const withBalance = importInputOf(
      { profileId: 'p1', closingBalance: '10', closingOn: '2026-11-30', dateFormatConfirmed: true },
      file
    )
    expect(withBalance).toEqual({
      ok: true,
      value: {
        profileId: 'p1',
        ...file,
        closing: { cents: 1000, on: '2026-11-30' },
        dateFormatConfirmed: true
      }
    })
  })

  it('reads the format and the days of the 409 that asks for the order of the day and the month', () => {
    const asked = new ApiError(409, 'RESOURCE_CONFLICT', 'x', 'c', {
      conflict: 'bank_date_format_unconfirmed',
      dateFormat: 'dd/MM/yyyy',
      firstDay: '2026-11-03',
      lastDay: '2026-11-05'
    })
    expect(bankDateFormatPromptOf(asked)).toEqual({
      dateFormat: 'dd/MM/yyyy',
      firstDay: '2026-11-03',
      lastDay: '2026-11-05'
    })
    expect(
      bankDateFormatPromptOf(
        new ApiError(409, 'RESOURCE_CONFLICT', 'x', 'c', {
          conflict: 'bank_date_format_unconfirmed'
        })
      )
    ).toBeNull()
    expect(
      bankDateFormatPromptOf(
        new ApiError(409, 'RESOURCE_CONFLICT', 'x', 'c', { conflict: 'bank_changed' })
      )
    ).toBeNull()
    expect(bankDateFormatPromptOf(new Error('x'))).toBeNull()
  })

  it('reads the kind of a conflict, and nothing else', () => {
    const conflict = (kind: unknown): ApiError =>
      new ApiError(409, 'RESOURCE_CONFLICT', 'x', 'corr', { conflict: kind })

    expect(bankConflictOf(conflict('bank_changed'))).toBe('bank_changed')
    expect(bankConflictOf(conflict('Bank Changed'))).toBeNull()
    expect(bankConflictOf(conflict(7))).toBeNull()
    expect(
      bankConflictOf(new ApiError(400, 'VALIDATION_FAILED', 'x', 'c', { conflict: 'bank_changed' }))
    ).toBeNull()
  })
})

describe('the lines and why a pair is suggested', () => {
  const line = (over: Partial<BankLineView>): BankLineView => ({
    id: 'l1',
    importId: 'i1',
    lineNo: 1,
    postedOn: '2026-11-03',
    amountCents: -1500,
    description: null,
    reference: null,
    match: null,
    suggestions: [],
    ...over
  })
  const suggestion = {
    bookLineId: 'j1',
    dayDifference: 0,
    referenceMatch: false,
    exact: true,
    entryId: 'e1',
    entryNumber: 'JE-1',
    entryDate: '2026-11-03',
    memo: null,
    signedCents: -1500
  }

  it('is matched, suggested or open, in that order of strength', () => {
    const match = {
      id: 'm1',
      journalLineId: 'j1',
      entryId: 'e1',
      entryNumber: 'JE-1',
      entryDate: '2026-11-03',
      decidedBy: 'u1',
      decidedAt: '2026-11-16T10:00:00.000Z'
    }
    expect(lineStateOf(line({ match, suggestions: [suggestion] }))).toBe('matched')
    expect(lineStateOf(line({ suggestions: [suggestion] }))).toBe('suggested')
    expect(lineStateOf(line({}))).toBe('unmatched')
  })

  it('says the amount, the day or the days apart, and the reference when it agrees', () => {
    expect(reasonsOf({ dayDifference: 0, referenceMatch: false })).toEqual([
      { reason: 'sameAmount' },
      { reason: 'sameDay' }
    ])
    expect(reasonsOf({ dayDifference: 2, referenceMatch: true })).toEqual([
      { reason: 'sameAmount' },
      { reason: 'daysApart', days: 2 },
      { reason: 'reference' }
    ])
  })

  it('opens the status on the month of the day in UTC', () => {
    expect(monthOf(new Date('2026-11-30T23:30:00Z'))).toEqual({ year: 2026, month: 11 })
    expect(monthOf(new Date('2027-01-01T00:00:00Z'))).toEqual({ year: 2027, month: 1 })
  })

  it('names the month or the year that is wrong', () => {
    expect(monthProblem('2026', '11')).toBeNull()
    expect(monthProblem('26', '11')).toBe('year')
    expect(monthProblem('2026', '13')).toBe('month')
    expect(monthProblem('2026', '0')).toBe('month')
    expect(monthProblem('2026', 'x')).toBe('month')
  })
})
