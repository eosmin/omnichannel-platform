import { PurchaseOrigins } from '@platform/core/domain'
import { FiscalAnnexError, type FiscalAnnexPurchase } from '@platform/fiscal/sdk'

import { svAnnexes } from './sv-annex-exporter'
import { SvAnnexErrors, SvAnnexIds } from './sv-constants'

const CODE = '0b7e1c2a-6f34-4d8e-9a51-3c2d7e8f9a10'
const NIT = '0614-010101-101-3'
const PERIOD = { year: 2026, month: 11 }

const purchase = (extra: Partial<FiscalAnnexPurchase> = {}, doc = {}): FiscalAnnexPurchase => ({
  receiptId: 'r-001',
  receivedOn: '2026-11-10',
  supplierName: 'Proveedor Uno',
  supplierTaxId: NIT,
  documentNumber: 'N-1',
  taxCreditable: true,
  taxedBaseCents: 10000,
  taxedLines: 1,
  taxCents: 1300,
  exemptBaseCents: 0,
  document: {
    issuedOn: '2026-11-05',
    receivedOn: '2026-11-10',
    documentClass: '4',
    documentType: '03',
    generationCode: CODE,
    documentNumber: 'N-1',
    origin: PurchaseOrigins.INTERNAL,
    expenseClass: '1',
    sector: '2',
    costType: '5',
    ...doc
  },
  ...extra
})

const build = (purchases: readonly FiscalAnnexPurchase[], period = PERIOD) =>
  svAnnexes.buildPurchases?.(SvAnnexIds.PURCHASES, period, purchases) ?? null
const rows = (purchases: readonly FiscalAnnexPurchase[], period = PERIOD): string[][] =>
  (build(purchases, period)?.content ?? '')
    .split('\r\n')
    .filter(line => line !== '')
    .map(line => line.split(';'))
const refusal = (purchases: readonly FiscalAnnexPurchase[]): FiscalAnnexError => {
  try {
    build(purchases)
  } catch (error) {
    if (error instanceof FiscalAnnexError) return error
  }
  throw new Error('the annex was made')
}

describe('the annex of purchases of the return (annex 3, columns A to U)', () => {
  it('is one of the annexes of the provider, made from the purchases and not from the documents', () => {
    expect(svAnnexes.ids).toContain(SvAnnexIds.PURCHASES)
    expect(svAnnexes.purchaseIds).toEqual([SvAnnexIds.PURCHASES])
    expect(svAnnexes.build(SvAnnexIds.PURCHASES, PERIOD, [])).toBeNull()
    expect(svAnnexes.buildPurchases?.('sales-taxpayers', PERIOD, [])).toBeNull()
  })

  it('writes a taxed purchase of a received electronic document, column by column', () => {
    const [row] = rows([purchase()])
    expect(row).toEqual([
      '05/11/2026', // A day of issue
      '4', // B
      '03', // C
      '0B7E1C2A6F344D8E9A513C2D7E8F9A10', // D the code of generation, no dashes, in capitals
      '06140101011013', // E NIT without dashes
      'Proveedor Uno', // F
      '0.00', // G
      '0.00', // H
      '0.00', // I
      '100.00', // J internal taxed
      '0.00', // K
      '0.00', // L
      '0.00', // M
      '13.00', // N credit
      '100.00', // O total of G to M, the tax is not in it
      '', // P
      '1', // Q taxed
      '1', // R cost
      '2', // S commerce
      '5', // T
      '3' // U number of the annex
    ])
  })

  it('has no header, ends each row and holds two decimals with no thousands separator', () => {
    const file = build([purchase({ taxedBaseCents: 123456789, taxCents: 16049383 })])
    expect(file?.content.endsWith('\r\n')).toBe(true)
    expect(file?.content).toContain(';1234567.89;')
    expect(file?.content).not.toContain(',')
    expect(file?.filename).toBe('f07-purchases-2026-11.csv')
    expect(file?.rows).toBe(1)
  })

  it('writes a printed document with its own number and an exempt purchase in the exempt column', () => {
    const [row] = rows([
      purchase(
        { taxedBaseCents: 0, taxCents: 0, exemptBaseCents: 2500 },
        { documentClass: '1', generationCode: null, documentNumber: 'FAC-77' }
      )
    ])
    expect(row?.slice(0, 5)).toEqual(['05/11/2026', '1', '03', 'FAC-77', '06140101011013'])
    expect(row?.slice(6, 16)).toEqual([
      '25.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '25.00',
      ''
    ])
    expect(row?.[16]).toBe('2')
  })

  it('reads a bill that has taxed and exempt lines as a mixed operation', () => {
    const [row] = rows([purchase({ exemptBaseCents: 500 })])
    expect(row?.slice(6, 15)).toEqual([
      '5.00',
      '0.00',
      '0.00',
      '100.00',
      '0.00',
      '0.00',
      '0.00',
      '13.00',
      '105.00'
    ])
    expect(row?.[16]).toBe('4')
  })

  it('puts the origin of the purchase in its column, taxed and exempt', () => {
    const at = (origin: string, taxed: boolean, extra = {}) =>
      rows([
        purchase(taxed ? {} : { taxedBaseCents: 0, taxCents: 0, exemptBaseCents: 10000 }, {
          origin,
          documentClass: '3',
          documentType: '12',
          generationCode: null,
          ...extra
        })
      ])[0]?.slice(6, 13)
    expect(at(PurchaseOrigins.INTERNATION, true)).toEqual([
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '100.00',
      '0.00',
      '0.00'
    ])
    expect(at(PurchaseOrigins.INTERNATION, false)).toEqual([
      '0.00',
      '100.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00'
    ])
    expect(at(PurchaseOrigins.IMPORT_GOODS, true)).toEqual([
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '100.00',
      '0.00'
    ])
    expect(at(PurchaseOrigins.IMPORT_GOODS, false)).toEqual([
      '0.00',
      '0.00',
      '100.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00'
    ])
    expect(at(PurchaseOrigins.IMPORT_SERVICES, true, { documentType: '13' })).toEqual([
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '100.00'
    ])
    expect(at(PurchaseOrigins.IMPORT_SERVICES, false, { documentType: '13' })).toEqual([
      '0.00',
      '0.00',
      '100.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00'
    ])
  })

  it('names the treasury as the supplier of a document of the customs or the treasury, whoever it was written for', () => {
    const [row] = rows([
      purchase(
        { supplierTaxId: '123456789', supplierName: 'Supplier Abroad' },
        {
          documentClass: '3',
          documentType: '12',
          generationCode: null,
          origin: PurchaseOrigins.IMPORT_GOODS
        }
      )
    ])
    expect(row?.[4]).toBe('06140108140066')
    expect(row?.[5]).toBe('Dirección General de Tesorería')
    expect(row?.[15]).toBe('')
  })

  it('writes the DUI of a person in its column and leaves the NIT or NRC empty, and an NRC with no leading zeros', () => {
    // 01234567-8: the check digit of a DUI (the rule is the public one, sv-tax-id.ts)
    const dui = rows([purchase({ supplierTaxId: '01234567-8' })])[0]
    expect(dui?.[4]).toBe('')
    expect(dui?.[15]).toBe('012345678')
    expect(rows([purchase({ supplierTaxId: '000123-4' })])[0]?.[4]).toBe('1234')
    expect(rows([purchase({ supplierTaxId: '1234567' })])[0]?.[4]).toBe('1234567')
  })

  it('refuses a supplier whose tax id is none of a NIT, an NRC or a DUI, naming the receipts and no data', () => {
    for (const taxId of [null, '', 'ABC', '12345678-9', '1']) {
      const error = refusal([
        purchase({ receiptId: 'r-b', supplierTaxId: taxId }),
        purchase({ receiptId: 'r-a', supplierTaxId: taxId })
      ])
      expect(error.code).toBe(SvAnnexErrors.PURCHASE_SUPPLIER)
      expect(error.refs).toEqual(['r-a', 'r-b'])
      expect(error.message).not.toContain('ABC')
    }
  })

  it('leaves the columns of the classification at "0" before 2024-02 and writes them from then on', () => {
    const [early] = rows([purchase({ receivedOn: '2024-01-15' })], { year: 2024, month: 1 })
    expect(early?.slice(16, 20)).toEqual(['0', '0', '0', '0'])
    const [late] = rows([purchase({ receivedOn: '2024-02-15' })], { year: 2024, month: 2 })
    expect(late?.slice(16, 20)).toEqual(['1', '1', '2', '5'])
  })

  it('writes a credit note and a debit note with positive figures and their own type', () => {
    const [credit, debit] = rows([
      purchase({ receiptId: 'r-1' }, { documentType: '05', generationCode: CODE }),
      purchase(
        { receiptId: 'r-2' },
        { documentType: '06', generationCode: '1b7e1c2a-6f34-4d8e-9a51-3c2d7e8f9a10' }
      )
    ])
    expect(credit?.[2]).toBe('05')
    expect(debit?.[2]).toBe('06')
    expect((credit ?? []).join(';')).not.toContain('-')
    expect((debit ?? []).join(';')).not.toContain('-')
    expect(credit?.[14]).toBe('100.00')
  })

  it('lets the tax of a receipt of many lines differ from the share of the whole by what the rounding of each line explains', () => {
    // Five lines of 0.10 keep 0.01 of tax each: 0.05 against the 0.07 of the whole (the half rounds up), two cents apart
    const many = purchase({ taxedBaseCents: 50, taxCents: 5, taxedLines: 5 })
    expect(rows([many])).toHaveLength(1)
    expect(refusal([{ ...many, taxedLines: 1 }]).code).toBe(SvAnnexErrors.PURCHASE_AMOUNTS)
    // More than the rounding of its lines can explain is still a refusal
    expect(
      refusal([purchase({ taxedBaseCents: 100000, taxCents: 12990, taxedLines: 2 })]).code
    ).toBe(SvAnnexErrors.PURCHASE_AMOUNTS)
  })

  it('refuses a purchase whose credit is not the 13 % of its taxed operations, within a cent', () => {
    const near = [
      purchase({ taxCents: 1299 }),
      purchase({ receiptId: 'r-2', taxCents: 1301 }),
      purchase({ receiptId: 'r-3', taxedBaseCents: 1, taxCents: 0 })
    ]
    expect(rows(near)).toHaveLength(3)
    const far = refusal([purchase({ receiptId: 'r-9', taxCents: 1298 }), purchase()])
    expect(far.code).toBe(SvAnnexErrors.PURCHASE_AMOUNTS)
    expect(far.refs).toEqual(['r-9'])
    // A tax that is not credited is not the annex's
    expect(refusal([purchase({ taxCreditable: false })]).code).toBe(SvAnnexErrors.PURCHASE_AMOUNTS)
  })

  it('checks the rules of the manual again on what it reads, and names every receipt that breaks one', () => {
    const error = refusal([
      purchase({ receiptId: 'r-2' }, { documentClass: '3' }),
      purchase({ receiptId: 'r-1' }, { costType: '9' }),
      purchase({ receiptId: 'r-3' }, { issuedOn: '2026-06-01' }),
      purchase({ receiptId: 'r-4' })
    ])
    expect(error.code).toBe(SvAnnexErrors.PURCHASE_DOCUMENT)
    expect(error.refs).toEqual(['r-1', 'r-2', 'r-3'])
  })

  it('takes the receipts of the month only, in order of the day of issue, and an empty month is an empty file', () => {
    const file = build([
      purchase({ receiptId: 'r-3', receivedOn: '2026-12-01' }),
      purchase(
        { receiptId: 'r-2' },
        { issuedOn: '2026-11-09', generationCode: '2b7e1c2a-6f34-4d8e-9a51-3c2d7e8f9a10' }
      ),
      purchase({ receiptId: 'r-1' }, { issuedOn: '2026-10-30' }),
      purchase({ receiptId: 'r-0', receivedOn: '2026-10-31' })
    ])
    expect(file?.rows).toBe(2)
    expect(rows([purchase({ receivedOn: '2026-12-01' })])).toEqual([])
    expect(build([])?.content).toBe('')
  })

  it('writes the same bytes for the same receipts, in whatever order they come', () => {
    const a = purchase({ receiptId: 'r-a' }, { issuedOn: '2026-11-02' })
    const b = purchase(
      { receiptId: 'r-b' },
      { issuedOn: '2026-11-03', generationCode: '3b7e1c2a-6f34-4d8e-9a51-3c2d7e8f9a10' }
    )
    expect(build([a, b])?.content).toBe(build([b, a])?.content)
  })

  it('never lets a name start a formula or break a cell', () => {
    const [row] = rows([purchase({ supplierName: '=HYPERLINK("x";"y")\nSecond; line' })])
    expect(row).toHaveLength(21)
    expect(row?.[5]).not.toMatch(/^[=+\-@\s]/u)
    expect(row?.[5]).not.toContain('"')
  })
})
