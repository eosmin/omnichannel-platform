import type { BankProfileView } from '@platform/api-client'
import { BankStatementLimits } from '@platform/core/domain'

import {
  type BankProfileDraft,
  BankProfileFields,
  bankDraftOf,
  bankHeaderSuggestions,
  bankReadingOf,
  createBankProfileInputOf,
  decimalKey,
  delimiterKey,
  emptyBankDraft,
  guessBankDelimiter,
  MoneyModes,
  skipRowsOfDraft,
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

describe('the sample of a file that starts with a lead of report lines', () => {
  const sample = [
    ',,,Statement of account,,',
    ',,,"Period\nfrom a day to a day",,',
    ',,,,,',
    ',Date,Memo,Ref,Debit,Credit',
    ',19/11/2026,Deposit,R1,0.00,5.00'
  ].join('\r\n')

  it('suggests the names of the row after the lead, not the words of a title', () => {
    expect(bankHeaderSuggestions(sample, ',', 2)).toEqual([
      'Date',
      'Memo',
      'Ref',
      'Debit',
      'Credit'
    ])
    expect(bankHeaderSuggestions(sample, ',', 0)).toEqual(['Statement of account'])
    expect(bankHeaderSuggestions(sample, ',', 40)).toEqual([])
  })

  it('guesses the delimiter from the row after the lead', () => {
    expect(guessBankDelimiter(sample, 2)).toBe(',')
    expect(guessBankDelimiter('Titulo\n\na;b;c;d\n1;2;3;4', 1)).toBe(';')
    expect(guessBankDelimiter('a\tb\tc', 0)).toBe('\t')
    expect(guessBankDelimiter('nothing to cut', 0)).toBe(',')
  })

  it('reads the rows to skip of the form, and none when it is not a number in range', () => {
    expect(skipRowsOfDraft({ skipRows: ' 14 ' })).toBe(14)
    for (const bad of ['', 'x', '-1', '51', '1.5'])
      expect(skipRowsOfDraft({ skipRows: bad })).toBe(0)
  })
})

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
        skipRows: 0,
        decimalSeparator: '.',
        thousandsSeparator: 'none',
        dateFormat: 'yyyy-MM-dd',
        encoding: 'utf-8',
        dateWindowDays: BankStatementLimits.DATE_WINDOW_DEFAULT_DAYS,
        columns: { date: 'Fecha', description: 'Detalle', reference: 'Ref', amount: 'Monto' }
      }
    })
  })

  it('sends how many rows to skip, as a whole number from 0 to the most the api takes, and refuses anything else', () => {
    expect(bankReadingOf(signed({ skipRows: '14' })).ok).toBe(true)
    const read = bankReadingOf(signed({ skipRows: ' 14 ' }))
    expect(read.ok && read.value.skipRows).toBe(14)
    for (const bad of ['', 'x', '-1', '1.5', '51', '100', '1e1']) {
      expect(bankReadingOf(signed({ skipRows: bad }))).toEqual({ ok: false, field: 'skipRows' })
    }
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
      'skipRows',
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
      skipRows: 9,
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
      skipRows: 9,
      decimalSeparator: ',',
      thousandsSeparator: 'dot',
      dateFormat: 'dd/MM/yyyy',
      encoding: 'windows-1252',
      dateWindowDays: 5,
      columns: { date: 0, debit: 3, credit: 4, description: 1 }
    })
    expect(draft.skipRows).toBe('9')
  })

  it('names the delimiters and the decimal separators by word', () => {
    expect(['\t', ';', ','].map(delimiterKey)).toEqual(['tab', 'semicolon', 'comma'])
    expect(['.', ','].map(decimalKey)).toEqual(['dot', 'comma'])
  })
})
