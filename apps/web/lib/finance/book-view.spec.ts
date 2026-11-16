import type { FinanceBookLayoutView, FinanceBookView } from '@platform/api-client'
import { LegalBookField, LegalBookKind } from '@platform/core/domain'

import {
  bookColumns,
  bookFileName,
  bookWarnings,
  isCentsCell,
  moneyColumnsAreKnown,
  totalCells
} from './book-view'

const layout = (version: number, fields: string[]): FinanceBookLayoutView => ({
  kind: LegalBookKind.SALES_TAXPAYERS,
  version,
  source: 'stored',
  accountantConfirmed: false,
  columns: fields.map(field => ({ field, label: null })),
  sort: 'date',
  correlativeStart: 1,
  correlativeRestart: 'month',
  unissuedSales: 'consumers',
  createdAt: null
})

const book = (version: number, header: string[]): Pick<FinanceBookView, 'header' | 'layout'> => ({
  header,
  layout: { version, source: 'stored', accountantConfirmed: false }
})

describe('which column of a book is money', () => {
  it('reads the fields from the layout of the same version, whatever the headers say', () => {
    const columns = bookColumns(
      book(2, ['No.', 'Fecha', 'Neto', 'IVA']),
      [
        layout(2, [
          LegalBookField.CORRELATIVE,
          LegalBookField.DATE,
          LegalBookField.BASE,
          LegalBookField.TAX
        ])
      ],
      LegalBookKind.SALES_TAXPAYERS
    )
    expect(columns.map(column => column.money)).toEqual([false, false, true, true])
  })

  it('does not take the layout of another kind', () => {
    const columns = bookColumns(
      book(2, ['No.', 'Neto']),
      [layout(2, [LegalBookField.CORRELATIVE, LegalBookField.BASE])],
      LegalBookKind.PURCHASES
    )
    expect(columns.every(column => !column.money)).toBe(true)
  })

  it('does not take the layout of another version', () => {
    const columns = bookColumns(
      book(1, ['No.', 'Neto']),
      [layout(2, [LegalBookField.CORRELATIVE, LegalBookField.BASE])],
      LegalBookKind.SALES_TAXPAYERS
    )
    // Headers that are no field names say nothing: plain text, never an amount
    expect(columns.map(column => column.money)).toEqual([false, false])
  })

  it('falls back to a header that is a field name (the proposal writes them so)', () => {
    const columns = bookColumns(
      book(0, ['correlative', 'base', 'tax', 'total']),
      undefined,
      LegalBookKind.SALES_TAXPAYERS
    )
    expect(columns.map(column => column.money)).toEqual([false, true, true, true])
  })

  it('does not trust a layout whose column count differs from the book', () => {
    const columns = bookColumns(
      book(2, ['a', 'b', 'c']),
      [layout(2, [LegalBookField.BASE])],
      LegalBookKind.SALES_TAXPAYERS
    )
    expect(columns.every(column => !column.money)).toBe(true)
  })
})

describe('a cell of money', () => {
  it('is a whole number of cents and nothing else', () => {
    expect(isCentsCell(1250)).toBe(true)
    expect(isCentsCell(-5)).toBe(true)
    expect(isCentsCell(12.5)).toBe(false)
    expect(isCentsCell('1250')).toBe(false)
    expect(isCentsCell(null)).toBe(false)
  })
})

describe('the totals row', () => {
  it('carries the sum of the api under each money column and nothing under the rest', () => {
    const columns = [
      { field: LegalBookField.DATE, money: false },
      { field: LegalBookField.BASE, money: true },
      { field: LegalBookField.TAX, money: true },
      { field: null, money: false }
    ]
    expect(totalCells(columns, { base: 1000, tax: 130 })).toEqual([null, 1000, 130, null])
    expect(totalCells(columns, {})).toEqual([null, null, null, null])
  })
})

describe('the warnings of a book', () => {
  it('lists only what is not zero', () => {
    expect(
      bookWarnings({
        salesWithoutTaxSnapshot: 0,
        salesNotReadable: 2,
        voidedDocuments: 0,
        unclassifiedDocuments: 1,
        returnsNotListed: 0
      })
    ).toEqual([
      { key: 'salesNotReadable', count: 2 },
      { key: 'unclassifiedDocuments', count: 1 }
    ])
  })
})

describe('the name of a downloaded book', () => {
  it('says the kind and the month, and that it is a draft when it is one', () => {
    expect(bookFileName('purchases', { year: 2026, month: 3 }, null)).toBe('purchases-2026-03.csv')
    expect(bookFileName('purchases', { year: 2026, month: 11 }, 'draft')).toBe(
      'purchases-2026-11-draft.csv'
    )
  })
})

describe('whether the money columns are known', () => {
  it('is false for a book that totals money and shows no column it can call money', () => {
    const plain = [{ field: null, money: false }]
    expect(moneyColumnsAreKnown(plain, { base: 100 })).toBe(false)
    expect(moneyColumnsAreKnown(plain, {})).toBe(true)
    expect(moneyColumnsAreKnown([{ field: 'base', money: true }], { base: 100 })).toBe(true)
  })
})
