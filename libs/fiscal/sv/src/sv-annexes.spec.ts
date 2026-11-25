import { FiscalDocumentKind } from '@platform/core/domain'
import {
  FiscalAnnexError,
  type FiscalAnnexDocument,
  type FiscalAnnexFile
} from '@platform/fiscal/sdk'

import { annexMoney, svAnnexes } from './sv-annexes'
import { buildDocument } from './sv-build'
import { SvAnnexErrors, SvAnnexIds, SvProviderDataKeys } from './sv-constants'
import { BUSINESS, credited, line, sale } from './testing/sv-fixtures'

// The annexes of the F-07 (manual of annexes V14, January 2025). Every column is pinned with the page of the manual it comes from, in the
// code under test.

// The file of an annex the exporter makes (a missing one is a fault of the spec)
function build(...args: Parameters<typeof svAnnexes.build>): FiscalAnnexFile {
  const file = svAnnexes.build(...args)
  if (file === null) throw new Error('the exporter has no such annex')
  return file
}

const SEAL = 'B'.repeat(40)
const NOV = { year: 2026, month: 11 }

interface Made {
  readonly uuid: string
  readonly issuedAt: string
  readonly voidedAt?: string
  readonly seal?: string | null
}

function made(over: Parameters<typeof sale>[0], how: Made): FiscalAnnexDocument {
  const built = buildDocument(sale({ documentUuid: how.uuid, issuedAt: how.issuedAt, ...over }))
  const seal = how.seal === undefined ? SEAL : how.seal
  return {
    documentType: built.documentType,
    externalNumber: null,
    providerData: seal === null ? {} : { [SvProviderDataKeys.RECEPTION_SEAL]: seal },
    payload: built.payload,
    issuedAt: new Date(how.issuedAt),
    voidedAt: how.voidedAt === undefined ? null : new Date(how.voidedAt)
  }
}

const rowsOf = (content: string): string[][] =>
  content === ''
    ? []
    : content
        .replace(/\r\n$/, '')
        .split('\r\n')
        .map(row => row.split(';'))

const U1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
const U2 = '2b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
const U3 = '3b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
const U4 = '4b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'

describe('annexMoney', () => {
  it('writes two decimals, a point and no thousands separator, from whole cents', () => {
    expect(annexMoney(0)).toBe('0.00')
    expect(annexMoney(5)).toBe('0.05')
    expect(annexMoney(2825)).toBe('28.25')
    expect(annexMoney(123456789)).toBe('1234567.89')
    expect(annexMoney(-120)).toBe('-1.20')
  })
  it('refuses a figure that is not whole cents', () => {
    expect(() => annexMoney(1.5)).toThrow(FiscalAnnexError)
  })
})

describe('annex of sales to consumers (annex 2, columns A to W)', () => {
  // 2026-11-17T03:30Z and 2026-11-17T05:00Z are the 16th in El Salvador; 2026-11-17T12:00Z is the 17th
  const docs = [
    made({}, { uuid: U1, issuedAt: '2026-11-17T03:30:15.000Z' }),
    made({}, { uuid: U2, issuedAt: '2026-11-17T05:00:00.000Z' }),
    made({}, { uuid: U3, issuedAt: '2026-11-17T12:00:00.000Z' })
  ]

  it('groups the invoices by day with the first and the last generation code of the day, N/A where the manual says so', () => {
    const file = build(SvAnnexIds.SALES_CONSUMERS, NOV, docs)
    const rows = rowsOf(file.content)
    expect(file.rows).toBe(2)
    expect(file.filename).toBe('f07-sales-consumers-2026-11.csv')
    expect(rows[0]).toEqual([
      '16/11/2026', // A
      '4', // B
      '01', // C
      'N/A', // D
      'N/A', // E
      'N/A', // F
      'N/A', // G
      U1.toUpperCase().replace(/-/g, ''), // H first of the day
      U2.toUpperCase().replace(/-/g, ''), // I last of the day
      '', // J
      '0.00', // K
      '0.00', // L
      '0.00', // M
      '56.50', // N, tax included
      '0.00', // O
      '0.00', // P
      '0.00', // Q
      '0.00', // R
      '0.00', // S
      '56.50', // T
      '1', // U taxed
      '3', // V commercial
      '2' // W
    ])
    expect(rows[1]?.[0]).toBe('17/11/2026')
    expect(rows[1]?.[7]).toBe(rows[1]?.[8])
    expect(rows.every(row => row.length === 23)).toBe(true)
  })

  it('leaves out a month that is not the one asked for, by the day in El Salvador and not in UTC', () => {
    // 2026-12-01T03:00Z is still the 30th of November in El Salvador; 2026-12-01T06:00Z is the 1st of December
    const edge = [
      made({}, { uuid: U1, issuedAt: '2026-12-01T03:00:00.000Z' }),
      made({}, { uuid: U2, issuedAt: '2026-12-01T06:00:00.000Z' })
    ]
    const november = rowsOf(build(SvAnnexIds.SALES_CONSUMERS, NOV, edge).content)
    expect(november).toHaveLength(1)
    expect(november[0]?.[0]).toBe('30/11/2026')
    const december = rowsOf(
      build(SvAnnexIds.SALES_CONSUMERS, { year: 2026, month: 12 }, edge).content
    )
    expect(december).toHaveLength(1)
    expect(december[0]?.[0]).toBe('01/12/2026')
  })

  it('writes 0 in the rent columns before January 2025 and not before', () => {
    const old = made({}, { uuid: U1, issuedAt: '2024-12-15T18:00:00.000Z' })
    const row = rowsOf(
      build(SvAnnexIds.SALES_CONSUMERS, { year: 2024, month: 12 }, [old]).content
    )[0]
    expect(row?.slice(20, 22)).toEqual(['0', '0'])
  })

  it('leaves out a document voided in its own month, keeps one voided later, and says mixed when both kinds of sale are in a day', () => {
    const voidedSame = made(
      {},
      { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z', voidedAt: '2026-11-18T12:00:00.000Z' }
    )
    const voidedLater = made(
      {},
      { uuid: U2, issuedAt: '2026-11-17T13:00:00.000Z', voidedAt: '2026-12-02T12:00:00.000Z' }
    )
    const exemptLine = made(
      {
        lines: [
          line({ taxTreatment: 'exempt' as never, taxCents: 0, totalCents: 2260, taxRateBps: 0 })
        ],
        shippingCents: 0,
        shippingTaxCents: 0,
        totalCents: 2260,
        taxCents: 0
      },
      { uuid: U3, issuedAt: '2026-11-17T14:00:00.000Z' }
    )
    const rows = rowsOf(
      build(SvAnnexIds.SALES_CONSUMERS, NOV, [voidedSame, voidedLater, exemptLine]).content
    )
    expect(rows).toHaveLength(1)
    // the first of the day is the one voided later (it was valid in the month), the voided in the month is not there
    expect(rows[0]?.[7]).toBe(U2.toUpperCase().replace(/-/g, ''))
    expect(rows[0]?.[10]).toBe('22.60')
    expect(rows[0]?.[13]).toBe('28.25')
    expect(rows[0]?.[19]).toBe('50.85')
    expect(rows[0]?.[20]).toBe('4')
  })

  it('is empty, and says so, for a month with no sale', () => {
    const file = build(SvAnnexIds.SALES_CONSUMERS, NOV, [])
    expect(file.content).toBe('')
    expect(file.rows).toBe(0)
  })
})

describe('annex of sales to taxpayers (annex 1, columns A to T)', () => {
  const ccf = made({ receiver: BUSINESS }, { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z' })

  it('writes the tax credit document with the control number, the seal and the code with no dashes', () => {
    const file = build(SvAnnexIds.SALES_TAXPAYERS, NOV, [ccf])
    const id = ccf.payload['identificacion'] as { numeroControl: string }
    const rows = rowsOf(file.content)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual([
      '17/11/2026', // A
      '4', // B
      '03', // C
      id.numeroControl.replace(/-/g, ''), // D
      SEAL, // E
      U1.toUpperCase().replace(/-/g, ''), // F
      '', // G
      '06140202021023', // H NIT
      'Cliente Contribuyente S.A.', // I
      '0.00', // J
      '0.00', // K
      '25.00', // L net sales
      '3.25', // M tax
      '0.00', // N
      '0.00', // O
      '25.00', // P J + K + L + N: the tax (3.25 of M) is not in it
      '', // Q
      '1', // R
      '3', // S
      '1' // T
    ])
    expect(file.filename).toBe('f07-sales-taxpayers-2026-11.csv')
  })

  it('writes a credit note with positive figures and its own type', () => {
    const note = made(
      {
        kind: FiscalDocumentKind.CREDIT_NOTE,
        credited: credited(),
        receiver: BUSINESS
      },
      { uuid: U2, issuedAt: '2026-11-17T13:00:00.000Z' }
    )
    const row = rowsOf(build(SvAnnexIds.SALES_TAXPAYERS, NOV, [note]).content)[0]
    expect(row?.[2]).toBe('05')
    expect(row?.slice(9, 16).every(cell => !cell.startsWith('-'))).toBe(true)
  })

  it('refuses a document that has no seal yet, never a file with a hole', () => {
    const unsealed = made(
      { receiver: BUSINESS },
      { uuid: U3, issuedAt: '2026-11-17T12:00:00.000Z', seal: null }
    )
    expect(() => build(SvAnnexIds.SALES_TAXPAYERS, NOV, [unsealed])).toThrow(
      new FiscalAnnexError(SvAnnexErrors.UNSEALED)
    )
  })

  it('puts the DUI of a natural person in its own column and leaves the tax number empty', () => {
    const person = made(
      { receiver: { ...BUSINESS, taxId: '01234567-8', documentType: '13' } },
      { uuid: U4, issuedAt: '2026-11-17T12:00:00.000Z' }
    )
    const row = rowsOf(build(SvAnnexIds.SALES_TAXPAYERS, NOV, [person]).content)[0]
    expect(row?.[7]).toBe('')
    expect(row?.[16]).toBe('012345678')
  })

  it('keeps a cell free of the separator, the quote and the line breaks', () => {
    const odd = made(
      { receiver: { ...BUSINESS, name: 'Ana; "la" \r\nSA' } },
      { uuid: U2, issuedAt: '2026-11-17T12:00:00.000Z' }
    )
    const cell = rowsOf(build(SvAnnexIds.SALES_TAXPAYERS, NOV, [odd]).content)[0]?.[8]
    expect(cell).toBe('Ana la SA')
  })

  it.each([
    ['=1+1', '1+1'],
    ['@x', 'x'],
    ['-2', '2'],
    ['+cmd', 'cmd'],
    ['  =HYPERLINK("x";"y")', 'HYPERLINK( x y )'],
    ['+=-@ Servicios S.A.', 'Servicios S.A.']
  ])(
    'drops the leading sign of the name %p so a spreadsheet never reads a formula',
    (name, cell) => {
      const doc = made(
        { receiver: { ...BUSINESS, name } },
        { uuid: U2, issuedAt: '2026-11-17T12:00:00.000Z' }
      )
      expect(rowsOf(build(SvAnnexIds.SALES_TAXPAYERS, NOV, [doc]).content)[0]?.[8]).toBe(cell)
    }
  )
})

describe('annex of voided documents (columns A to J)', () => {
  it('lists the DTE invalidated in the month, whatever month it was issued in, with the seal and the code with dashes', () => {
    const doc = made(
      {},
      { uuid: U1, issuedAt: '2026-10-20T12:00:00.000Z', voidedAt: '2026-12-01T05:59:00.000Z' }
    )
    const id = doc.payload['identificacion'] as { numeroControl: string }
    // 2026-12-01T05:59Z is still the 30th of November in El Salvador
    const rows = rowsOf(build(SvAnnexIds.VOIDED, NOV, [doc]).content)
    expect(rows).toEqual([
      [id.numeroControl, '4', '0', '0', '01', 'D', SEAL, '0', '0', U1.toUpperCase()]
    ])
    expect(rowsOf(build(SvAnnexIds.VOIDED, { year: 2026, month: 12 }, [doc]).content)).toEqual([])
  })
})

describe('annex 2: not-subject sales and the documents voided in a later month', () => {
  const notSubject = {
    lines: [
      line({
        taxTreatment: 'not_subject' as never,
        taxCents: 0,
        totalCents: 1000,
        taxRateBps: 0,
        unitPriceCents: 500,
        quantity: 2
      })
    ],
    shippingCents: 0,
    shippingTaxCents: 0,
    totalCents: 1000,
    taxCents: 0
  }
  const DEC = { year: 2026, month: 12 }
  const NEGATIVE_START = 'N/A;N/A;N/A;N/A'

  it('adds the not-subject sales of a day (M) to the total T, with the taxed (N) and the exempt (K)', () => {
    const docs = [
      made(notSubject, { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z' }),
      made({}, { uuid: U2, issuedAt: '2026-11-17T13:00:00.000Z' })
    ]
    const row = rowsOf(build(SvAnnexIds.SALES_CONSUMERS, NOV, docs).content)[0]
    expect(row?.[12]).toBe('10.00') // M
    expect(row?.[13]).toBe('28.25') // N
    expect(row?.[19]).toBe('38.25') // T = K + M + N
    expect(row?.[20]).toBe('4') // mixed
  })

  it('writes a document voided in a later month, within three periods, as a NEGATIVE row with the date of the original', () => {
    const doc = made(
      {},
      { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z', voidedAt: '2026-12-02T12:00:00.000Z' }
    )
    const december = rowsOf(build(SvAnnexIds.SALES_CONSUMERS, DEC, [doc]).content)
    expect(december).toHaveLength(1)
    expect(december[0]?.slice(0, 3)).toEqual(['17/11/2026', '4', '01'])
    expect(december[0]?.slice(3, 7).join(';')).toBe(NEGATIVE_START)
    expect(december[0]?.slice(10, 20)).toEqual([
      '0.00',
      '0.00',
      '0.00',
      '-28.25',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '-28.25'
    ])
    // And in its own month it is still the sale it was
    expect(rowsOf(build(SvAnnexIds.SALES_CONSUMERS, NOV, [doc]).content)[0]?.[13]).toBe('28.25')
  })

  it('writes nothing for one voided in its own month, or more than three periods after its issue', () => {
    const sameMonth = made(
      {},
      { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z', voidedAt: '2026-11-20T12:00:00.000Z' }
    )
    // Issued in August, voided in December: four periods
    const tooLate = made(
      {},
      { uuid: U2, issuedAt: '2026-08-17T12:00:00.000Z', voidedAt: '2026-12-02T12:00:00.000Z' }
    )
    // Issued in September, voided in December: three periods
    const justInTime = made(
      {},
      { uuid: U3, issuedAt: '2026-09-17T12:00:00.000Z', voidedAt: '2026-12-02T12:00:00.000Z' }
    )
    const rows = rowsOf(
      build(SvAnnexIds.SALES_CONSUMERS, DEC, [sameMonth, tooLate, justInTime]).content
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.[0]).toBe('17/09/2026')
  })

  it('leaves a tax credit document voided in another month out of annex 1 of both months, as the manual says', () => {
    const ccf = made(
      { receiver: BUSINESS },
      { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z', voidedAt: '2026-12-02T12:00:00.000Z' }
    )
    expect(rowsOf(build(SvAnnexIds.SALES_TAXPAYERS, DEC, [ccf]).content)).toEqual([])
  })
})

describe('a document that cannot be read', () => {
  const empty = (issuedAt: string): FiscalAnnexDocument => ({
    documentType: '01',
    externalNumber: null,
    providerData: null,
    payload: {},
    issuedAt: new Date(issuedAt),
    voidedAt: null
  })

  it('does not stop the month when it belongs to a neighbouring one', () => {
    const rows = rowsOf(
      build(SvAnnexIds.SALES_CONSUMERS, NOV, [
        empty('2026-12-01T10:00:00.000Z'),
        made({}, { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z' })
      ]).content
    )
    expect(rows).toHaveLength(1)
  })

  it('refuses the month it belongs to', () => {
    expect(() =>
      build(SvAnnexIds.SALES_CONSUMERS, NOV, [empty('2026-11-17T12:00:00.000Z')])
    ).toThrow(new FiscalAnnexError(SvAnnexErrors.UNREADABLE))
  })
})

describe('the exporter', () => {
  it('knows its annexes by own id only', () => {
    expect(svAnnexes.ids).toEqual([
      SvAnnexIds.SALES_TAXPAYERS,
      SvAnnexIds.SALES_CONSUMERS,
      SvAnnexIds.VOIDED
    ])
    expect(svAnnexes.build('constructor', NOV, [])).toBeNull()
    expect(svAnnexes.build('nope', NOV, [])).toBeNull()
  })
  it('refuses a document whose figures are not whole cents', () => {
    const doc = made({}, { uuid: U1, issuedAt: '2026-11-17T12:00:00.000Z' })
    const bad: FiscalAnnexDocument = {
      ...doc,
      payload: {
        ...doc.payload,
        resumen: { ...(doc.payload['resumen'] as object), totalGravada: 1.234 }
      }
    }
    expect(() => build(SvAnnexIds.SALES_CONSUMERS, NOV, [bad])).toThrow(
      new FiscalAnnexError(SvAnnexErrors.UNREADABLE)
    )
  })
})
