import type { RemittanceImportProfileView } from '@platform/api-client'
import {
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  RemittanceImportLimits
} from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import {
  byteLength,
  contentTypeOf,
  decodeFile,
  EMPTY_FORM,
  formOf,
  guessDelimiter,
  headerSuggestions,
  ImportEncodings,
  importErrorsOf,
  mappingOf,
  sameAsProfile,
  sampleOf
} from './import-mapper'

const buffer = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer

const profile = (
  overrides: Partial<RemittanceImportProfileView> = {}
): RemittanceImportProfileView => ({
  id: 'p1',
  connectionId: 'c1',
  name: 'Carrier file',
  delimiter: RemittanceDelimiters.SEMICOLON,
  hasHeader: true,
  decimalSeparator: RemittanceDecimalSeparators.COMMA,
  dateFormat: RemittanceDateFormats.DAY_FIRST_SLASH,
  columns: { guideNumber: 'Guia', amount: 'Monto', fee: 3 },
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  ...overrides
})

describe('decodeFile', () => {
  it('reads UTF-8 and refuses bytes that are not UTF-8 instead of showing broken letters', () => {
    const utf8 = new TextEncoder().encode('Guía;Monto').buffer
    expect(decodeFile(utf8, ImportEncodings.UTF8)).toEqual({
      ok: true,
      text: 'Guía;Monto',
      encoding: ImportEncodings.UTF8
    })
    // "Guía" saved by Excel as Windows-1252: the í is the single byte 0xED
    const latin = buffer([0x47, 0x75, 0xed, 0x61])
    expect(decodeFile(latin, ImportEncodings.UTF8)).toEqual({ ok: false, reason: 'not_text' })
    expect(decodeFile(latin, ImportEncodings.WINDOWS_1252)).toEqual({
      ok: true,
      text: 'Guía',
      encoding: ImportEncodings.WINDOWS_1252
    })
  })

  it('refuses an empty file, a binary one and one over the limit', () => {
    expect(decodeFile(buffer([]), ImportEncodings.UTF8)).toEqual({ ok: false, reason: 'empty' })
    expect(decodeFile(buffer([0x41, 0x00, 0x42]), ImportEncodings.UTF8)).toEqual({
      ok: false,
      reason: 'not_text'
    })
    const big = new ArrayBuffer(RemittanceImportLimits.MAX_BYTES + 1)
    expect(decodeFile(big, ImportEncodings.UTF8)).toEqual({ ok: false, reason: 'too_large' })
  })
})

describe('sampleOf', () => {
  it('keeps a small text as it is', () => {
    expect(sampleOf('a,b\n1,2')).toBe('a,b\n1,2')
  })

  it('leaves nothing when the first line alone is larger than a preview takes', () => {
    expect(sampleOf('x'.repeat(RemittanceImportLimits.PREVIEW_MAX_BYTES + 10))).toBe('')
  })

  it('keeps whole lines of a text with every kind of line break', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => `G-${index},15.50`)
    const sample = sampleOf(rows.join('\r\n'))
    expect(byteLength(sample)).toBeLessThanOrEqual(RemittanceImportLimits.PREVIEW_MAX_BYTES)
    expect(sample.split('\n').every(row => /^G-\d+,15\.50$/.test(row))).toBe(true)
    expect(sample.split('\n')[0]).toBe('G-0,15.50')
  })

  it('cuts a large one at a whole line, in bytes and not in characters', () => {
    const line = 'é'.repeat(100)
    const text = Array.from({ length: 1000 }, () => line).join('\n')
    const sample = sampleOf(text)
    expect(byteLength(sample)).toBeLessThanOrEqual(RemittanceImportLimits.PREVIEW_MAX_BYTES)
    expect(sample.split('\n').every(row => row === line)).toBe(true)
    expect(sample.length).toBeGreaterThan(0)
  })
})

describe('guessDelimiter and contentTypeOf', () => {
  it('suggests the delimiter that appears most in the first line', () => {
    expect(guessDelimiter('Guia;Monto;Fecha\n1;2;3')).toBe(RemittanceDelimiters.SEMICOLON)
    expect(guessDelimiter('Guia\tMonto\n1\t2')).toBe(RemittanceDelimiters.TAB)
    expect(guessDelimiter('Guia,Monto')).toBe(RemittanceDelimiters.COMMA)
    expect(guessDelimiter('Guia')).toBe(RemittanceDelimiters.COMMA)
  })

  it('sends a tab file as TSV and the rest as CSV', () => {
    expect(contentTypeOf(RemittanceDelimiters.TAB)).toBe('text/tab-separated-values')
    expect(contentTypeOf(RemittanceDelimiters.SEMICOLON)).toBe('text/csv')
  })
})

describe('headerSuggestions', () => {
  it('lists the cells of the first line without quotes, a BOM or repeats', () => {
    expect(
      headerSuggestions('\uFEFF"Guia", Monto ;Monto;;', RemittanceDelimiters.SEMICOLON)
    ).toEqual(['"Guia", Monto', 'Monto'])
    expect(headerSuggestions('"Guia","Monto"\n1,2', RemittanceDelimiters.COMMA)).toEqual([
      'Guia',
      'Monto'
    ])
    expect(headerSuggestions('', RemittanceDelimiters.COMMA)).toEqual([])
  })
})

describe('mappingOf', () => {
  const form = { ...EMPTY_FORM, guideNumber: ' Guia ', amount: 'Monto' }

  it('maps by header text with the spaces trimmed and leaves the optional ones out', () => {
    expect(mappingOf(form)).toEqual({
      ok: true,
      profile: {
        delimiter: ',',
        hasHeader: true,
        decimalSeparator: '.',
        dateFormat: 'yyyy-MM-dd',
        columns: { guideNumber: 'Guia', amount: 'Monto' }
      }
    })
  })

  it('names the required column that is missing', () => {
    expect(mappingOf({ ...form, amount: ' ' })).toEqual({
      ok: false,
      problem: { kind: 'required', field: 'amount' }
    })
  })

  it('maps a file with no header by position and refuses text there', () => {
    const noHeader = { ...form, hasHeader: false, guideNumber: '0', amount: '2', fee: '3' }
    const result = mappingOf(noHeader)
    expect(result.ok && result.profile.columns).toEqual({ guideNumber: 0, amount: 2, fee: 3 })
    expect(mappingOf({ ...noHeader, amount: 'Monto' })).toEqual({
      ok: false,
      problem: { kind: 'position', field: 'amount' }
    })
    expect(mappingOf({ ...noHeader, amount: '201' })).toEqual({
      ok: false,
      problem: { kind: 'position', field: 'amount' }
    })
  })

  it('refuses the rules the api repeats: a column used twice and a delimiter that is the decimal comma', () => {
    expect(mappingOf({ ...form, amount: 'guia' })).toEqual({ ok: false, problem: { kind: 'rule' } })
    expect(
      mappingOf({
        ...form,
        delimiter: RemittanceDelimiters.COMMA,
        decimalSeparator: RemittanceDecimalSeparators.COMMA
      })
    ).toEqual({ ok: false, problem: { kind: 'rule' } })
  })
})

describe('profiles and the form', () => {
  it('shows a saved profile in the form, a position as its number', () => {
    expect(formOf(profile())).toMatchObject({
      delimiter: ';',
      decimalSeparator: ',',
      guideNumber: 'Guia',
      amount: 'Monto',
      fee: '3',
      date: ''
    })
  })

  it('says the form is the profile only when nothing differs', () => {
    const saved = profile()
    expect(sameAsProfile(formOf(saved), saved)).toBe(true)
    expect(sameAsProfile({ ...formOf(saved), amount: ' Monto ' }, saved)).toBe(true)
    expect(sameAsProfile({ ...formOf(saved), amount: 'Total' }, saved)).toBe(false)
    expect(sameAsProfile({ ...formOf(saved), delimiter: ',' }, saved)).toBe(false)
    expect(sameAsProfile({ ...formOf(saved), date: 'Dia' }, saved)).toBe(false)
  })
})

describe('importErrorsOf', () => {
  it('reads the row errors of a refused file and the total the api counted', () => {
    const error = {
      code: ClientErrorCodes.REMITTANCE_IMPORT_INVALID,
      metadata: {
        errorCount: 250,
        errors: [
          { row: 3, field: 'amount', code: 'invalid_amount', value: 'abc' },
          { row: 4, field: null, code: 'row_too_wide', value: null },
          { nonsense: true }
        ]
      }
    }
    expect(importErrorsOf(error)).toEqual({
      count: 250,
      errors: [
        { row: 3, field: 'amount', code: 'invalid_amount', value: 'abc' },
        { row: 4, field: null, code: 'row_too_wide', value: null }
      ]
    })
  })

  it('is null for any other failure, so it is not shown as a row error', () => {
    expect(importErrorsOf({ code: ClientErrorCodes.INTERNAL_ERROR, metadata: {} })).toBeNull()
    expect(importErrorsOf(null)).toBeNull()
    expect(importErrorsOf(new Error('x'))).toBeNull()
  })
})
