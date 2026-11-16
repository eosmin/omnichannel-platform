import type { BankProfileView } from '@platform/api-client'
import { BankStatementLimits } from '@platform/core/domain'

import {
  type BankProfileDraft,
  BankProfileFields,
  bankDraftOf,
  bankReadingOf,
  createBankProfileInputOf,
  decimalKey,
  delimiterKey,
  emptyBankDraft,
  MoneyModes,
  updateBankProfileInputOf
} from './bank-form'

const signed = (over: Partial<BankProfileDraft> = {}): BankProfileDraft => ({
  ...emptyBankDraft(),
  name: 'Banco Uno',
  date: 'Fecha',
  amount: 'Monto',
  ...over
})

const split = (over: Partial<BankProfileDraft> = {}): BankProfileDraft =>
  signed({ mode: MoneyModes.SPLIT, amount: '', debit: 'Cargo', credit: 'Abono', ...over })

describe('the form of a bank profile', () => {
  it('makes the body of a profile with a signed amount column', () => {
    const result = createBankProfileInputOf(
      signed({ description: 'Detalle', reference: ' Ref ' }),
      'a1'
    )

    expect(result).toEqual({
      ok: true,
      value: {
        accountId: 'a1',
        name: 'Banco Uno',
        delimiter: ',',
        hasHeader: true,
        decimalSeparator: '.',
        thousandsSeparator: 'none',
        dateFormat: 'yyyy-MM-dd',
        encoding: 'utf-8',
        dateWindowDays: BankStatementLimits.DATE_WINDOW_DEFAULT_DAYS,
        columns: { date: 'Fecha', description: 'Detalle', reference: 'Ref', amount: 'Monto' }
      }
    })
  })

  it('sends a debit and a credit column and never the amount that is typed beside them', () => {
    const result = bankReadingOf(split({ amount: 'ignored' }))

    expect(result.ok && result.value.columns).toEqual({
      date: 'Fecha',
      debit: 'Cargo',
      credit: 'Abono'
    })
  })

  it('leaves out the optional columns that are blank', () => {
    const result = bankReadingOf(signed({ description: '   ', reference: '' }))

    expect(result.ok && Object.keys(result.value.columns).sort()).toEqual(['amount', 'date'])
  })

  it('names the first required column that is missing', () => {
    expect(bankReadingOf(signed({ date: '' }))).toEqual({
      ok: false,
      field: BankProfileFields.DATE
    })
    expect(bankReadingOf(signed({ amount: ' ' }))).toEqual({
      ok: false,
      field: BankProfileFields.AMOUNT
    })
    expect(bankReadingOf(split({ debit: '' }))).toEqual({
      ok: false,
      field: BankProfileFields.DEBIT
    })
    expect(bankReadingOf(split({ credit: '' }))).toEqual({
      ok: false,
      field: BankProfileFields.CREDIT
    })
  })

  it('maps by position when the file has no header, and refuses a name then', () => {
    const noHeader = signed({ hasHeader: false, date: '0', amount: '2', reference: '5' })

    const result = bankReadingOf(noHeader)

    expect(result.ok && result.value.columns).toEqual({ date: 0, amount: 2, reference: 5 })
    expect(bankReadingOf({ ...noHeader, date: 'Fecha' })).toEqual({
      ok: false,
      field: BankProfileFields.DATE
    })
    expect(bankReadingOf({ ...noHeader, amount: '201' })).toEqual({
      ok: false,
      field: BankProfileFields.AMOUNT
    })
  })

  it('refuses a profile that breaks a rule of the profiles, with the rule of the api', () => {
    // Two values from one column
    expect(bankReadingOf(signed({ reference: 'Fecha' }))).toEqual({
      ok: false,
      field: BankProfileFields.RULE
    })
    // The delimiter is the decimal separator
    expect(bankReadingOf(signed({ delimiter: ',', decimalSeparator: ',' }))).toEqual({
      ok: false,
      field: BankProfileFields.RULE
    })
    // The thousands separator is the decimal one
    expect(bankReadingOf(signed({ thousandsSeparator: 'dot', decimalSeparator: '.' }))).toEqual({
      ok: false,
      field: BankProfileFields.RULE
    })
  })

  it.each(['', 'x', '32', '-1', '1.5'])('refuses %j days apart', days => {
    expect(bankReadingOf(signed({ dateWindowDays: days }))).toEqual({
      ok: false,
      field: BankProfileFields.WINDOW
    })
  })

  it('accepts the window from 0 to the most the api takes', () => {
    expect(bankReadingOf(signed({ dateWindowDays: '0' })).ok).toBe(true)
    expect(
      bankReadingOf(signed({ dateWindowDays: String(BankStatementLimits.DATE_WINDOW_MAX_DAYS) })).ok
    ).toBe(true)
  })

  it('refuses a name that is empty, too long or has a line break', () => {
    for (const name of [
      '',
      '   ',
      'n'.repeat(BankStatementLimits.PROFILE_NAME_MAX_LENGTH + 1),
      'a\nb'
    ]) {
      expect(createBankProfileInputOf(signed({ name }), 'a1')).toEqual({
        ok: false,
        field: BankProfileFields.NAME
      })
    }
  })

  it('sends the whole reading on a change, with the name', () => {
    const result = updateBankProfileInputOf(signed({ name: ' Renamed ' }))

    expect(result.ok && result.value.name).toBe('Renamed')
    expect(result.ok && Object.keys(result.value).sort()).toEqual([
      'columns',
      'dateFormat',
      'dateWindowDays',
      'decimalSeparator',
      'delimiter',
      'encoding',
      'hasHeader',
      'name',
      'thousandsSeparator'
    ])
  })

  it('goes back and forth between a saved profile and the form', () => {
    const profile: BankProfileView = {
      id: 'p1',
      accountId: 'a1',
      name: 'Banco Dos',
      delimiter: ';',
      hasHeader: false,
      decimalSeparator: ',',
      thousandsSeparator: 'dot',
      dateFormat: 'dd/MM/yyyy',
      encoding: 'windows-1252',
      dateWindowDays: 5,
      columns: { date: 0, debit: 3, credit: 4, description: 1 },
      createdAt: '2026-11-16T10:00:00.000Z',
      updatedAt: '2026-11-16T10:00:00.000Z'
    }

    const draft = bankDraftOf(profile)
    const input = createBankProfileInputOf(draft, 'a1')

    expect(draft.mode).toBe(MoneyModes.SPLIT)
    expect(input.ok && input.value).toMatchObject({
      delimiter: ';',
      hasHeader: false,
      decimalSeparator: ',',
      thousandsSeparator: 'dot',
      dateFormat: 'dd/MM/yyyy',
      encoding: 'windows-1252',
      dateWindowDays: 5,
      columns: { date: 0, debit: 3, credit: 4, description: 1 }
    })
  })

  it('names the delimiters and the decimal separators by word', () => {
    expect(['\t', ';', ','].map(delimiterKey)).toEqual(['tab', 'semicolon', 'comma'])
    expect(['.', ','].map(decimalKey)).toEqual(['dot', 'comma'])
  })
})
