import {
  LegalBookCorrelativeRestart,
  LegalBookField,
  LegalBookFieldsOfKind,
  LegalBookKind,
  LegalBookLimits,
  LegalBookSort,
  LegalBookUnissuedSales
} from '@platform/core/domain'

import {
  type BookSourceRow,
  buildLegalBook,
  correlativeBucketStart,
  type LegalBookLayout,
  layoutProblem,
  LegalBookLayoutProblem,
  PROPOSED_BOOK_COLUMNS,
  proposedLayout,
  saleBookOfDocumentType
} from './legal-books'

const sale = (
  entryNumber: number,
  entryDate: string,
  documentNumber: string,
  totalCents: number
): BookSourceRow => ({
  entryNumber,
  entryDate,
  documentNumber,
  values: {
    [LegalBookField.DOCUMENT_NUMBER]: documentNumber,
    [LegalBookField.TAX]: Math.round((totalCents * 13) / 113),
    [LegalBookField.TOTAL]: totalCents
  }
})

const layoutOf = (over: Partial<LegalBookLayout> = {}): LegalBookLayout => ({
  ...proposedLayout(LegalBookKind.SALES_CONSUMERS),
  columns: [
    { field: LegalBookField.CORRELATIVE, label: null },
    { field: LegalBookField.DATE, label: 'Fecha' },
    { field: LegalBookField.DOCUMENT_NUMBER, label: null },
    { field: LegalBookField.TAX, label: null },
    { field: LegalBookField.TOTAL, label: null }
  ],
  ...over
})

describe('the proposed layouts', () => {
  it('only ask for fields their own kind of book may show', () => {
    for (const kind of Object.values(LegalBookKind)) {
      expect(layoutProblem(kind, proposedLayout(kind))).toBeNull()
      for (const { field } of PROPOSED_BOOK_COLUMNS[kind]) {
        expect(LegalBookFieldsOfKind[kind]).toContain(field)
      }
    }
  })

  it('carry no customer data: no field of the catalog names a buyer', () => {
    const all = Object.values(LegalBookField)
    expect(all.some(field => /buyer|customer|receiver|name_of_client/.test(field))).toBe(false)
  })
})

describe('layoutProblem', () => {
  const kind = LegalBookKind.SALES_CONSUMERS
  it('refuses an empty list of columns', () => {
    expect(layoutProblem(kind, layoutOf({ columns: [] }))).toBe(LegalBookLayoutProblem.NO_COLUMNS)
  })
  it('refuses a field of another kind of book', () => {
    expect(
      layoutProblem(
        kind,
        layoutOf({ columns: [{ field: LegalBookField.SUPPLIER_TAX_ID, label: null }] })
      )
    ).toBe(LegalBookLayoutProblem.FIELD_NOT_OF_BOOK)
  })
  it('refuses a field twice', () => {
    const column = { field: LegalBookField.TOTAL, label: null }
    expect(layoutProblem(kind, layoutOf({ columns: [column, column] }))).toBe(
      LegalBookLayoutProblem.FIELD_REPEATED
    )
  })
  it('refuses a label that is not a line of text', () => {
    for (const label of ['', 'a\nb', 'x'.repeat(LegalBookLimits.LABEL_MAX_LENGTH + 1)]) {
      expect(
        layoutProblem(kind, layoutOf({ columns: [{ field: LegalBookField.TOTAL, label }] }))
      ).toBe(LegalBookLayoutProblem.LABEL_NOT_VALID)
    }
  })
  it('refuses to order by document a correlative that runs through the year', () => {
    expect(
      layoutProblem(
        kind,
        layoutOf({
          sort: LegalBookSort.DOCUMENT,
          correlativeRestart: LegalBookCorrelativeRestart.YEAR
        })
      )
    ).toBe(LegalBookLayoutProblem.SORT_BREAKS_YEARLY_CORRELATIVE)
  })
  it('refuses a start of the correlative that is not a positive whole number', () => {
    for (const correlativeStart of [0, -1, 1.5, LegalBookLimits.CORRELATIVE_START_MAX + 1]) {
      expect(layoutProblem(kind, layoutOf({ correlativeStart }))).toBe(
        LegalBookLayoutProblem.CORRELATIVE_START_NOT_VALID
      )
    }
  })
})

describe('buildLegalBook', () => {
  const kind = LegalBookKind.SALES_CONSUMERS
  const range = { from: '2027-02-01', to: '2027-02-28' }

  it('numbers the rows from the start of the layout, in the order of the date and then of the entry', () => {
    const book = buildLegalBook(
      kind,
      layoutOf({ correlativeStart: 100 }),
      [
        sale(7, '2027-02-10', 'B', 1130),
        sale(5, '2027-02-10', 'A', 2260),
        sale(3, '2027-02-02', 'C', 113)
      ],
      range
    )
    expect(book.header).toEqual(['correlative', 'Fecha', 'document_number', 'tax', 'total'])
    expect(book.rows.map(row => [row[0], row[2]])).toEqual([
      [100, 'C'],
      [101, 'A'],
      [102, 'B']
    ])
    expect(book.totals).toEqual({
      [LegalBookField.TAX]: 13 + 260 + 130,
      [LegalBookField.TOTAL]: 3503
    })
  })

  it('can order by the number of the document, still breaking every tie by the entry', () => {
    const book = buildLegalBook(
      kind,
      layoutOf({ sort: LegalBookSort.DOCUMENT }),
      [
        sale(9, '2027-02-01', 'B', 100),
        sale(8, '2027-02-05', 'A', 100),
        sale(7, '2027-02-05', 'A', 100)
      ],
      range
    )
    expect(book.rows.map(row => row[2])).toEqual(['A', 'A', 'B'])
    expect(book.rows.map(row => row[0])).toEqual([1, 2, 3])
  })

  it('orders documents as numbers read (9 before 10) and puts a row with no document last', () => {
    const book = buildLegalBook(
      kind,
      layoutOf({ sort: LegalBookSort.DOCUMENT }),
      [sale(1, '2027-02-01', '10', 1), sale(2, '2027-02-01', '', 1), sale(3, '2027-02-01', '9', 1)],
      range
    )
    expect(book.rows.map(row => row[2])).toEqual(['9', '10', ''])
  })

  it('restarts the correlative every month, and the rows before the range do not shift it', () => {
    const book = buildLegalBook(
      kind,
      layoutOf(),
      [
        sale(1, '2027-01-31', 'J', 1),
        sale(2, '2027-02-01', 'F1', 1),
        sale(3, '2027-02-02', 'F2', 1)
      ],
      range
    )
    expect(book.rows.map(row => row[0])).toEqual([1, 2])
  })

  it('keeps one correlative through the year when the layout says so, whichever month is asked for', () => {
    const layout = layoutOf({ correlativeRestart: LegalBookCorrelativeRestart.YEAR })
    const sources = [
      sale(1, '2027-01-31', 'J', 1),
      sale(2, '2027-02-01', 'F1', 1),
      sale(3, '2027-02-02', 'F2', 1)
    ]
    const february = buildLegalBook(kind, layout, sources, range)
    const wholeYear = buildLegalBook(kind, layout, sources, {
      from: '2027-01-01',
      to: '2027-12-31'
    })
    expect(february.rows.map(row => row[0])).toEqual([2, 3])
    expect(wholeYear.rows.map(row => row[0])).toEqual([1, 2, 3])
  })

  it('is the same book however the sources arrive (byte for byte what a closed month gives)', () => {
    const sources = [
      sale(1, '2027-02-03', 'X', 500),
      sale(2, '2027-02-03', 'Y', 600),
      sale(3, '2027-02-04', 'Z', 700)
    ]
    const forward = buildLegalBook(kind, layoutOf(), sources, range)
    const backward = buildLegalBook(kind, layoutOf(), [...sources].reverse(), range)
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward))
  })

  it('writes null for a field the source does not have, and totals only the money columns', () => {
    const book = buildLegalBook(
      kind,
      layoutOf(),
      [{ entryNumber: 1, entryDate: '2027-02-03', documentNumber: '', values: {} }],
      range
    )
    expect(book.rows[0]).toEqual([1, '2027-02-03', null, null, null])
    expect(book.totals).toEqual({})
  })

  it('finds the start of a correlative stretch', () => {
    expect(correlativeBucketStart('2027-02-17', LegalBookCorrelativeRestart.MONTH)).toBe(
      '2027-02-01'
    )
    expect(correlativeBucketStart('2027-02-17', LegalBookCorrelativeRestart.YEAR)).toBe(
      '2027-01-01'
    )
  })

  it('leaves out of the proposal what the accountant has to decide: it asks for no buyer data', () => {
    expect(proposedLayout(kind).unissuedSales).toBe(LegalBookUnissuedSales.CONSUMERS)
  })
})

describe('saleBookOfDocumentType', () => {
  it("puts a type that asks for the receiver's tax identity in the book of taxpayers, whatever its name", () => {
    expect(saleBookOfDocumentType({ requiredReceiverFields: ['name', 'taxId'] })).toBe(
      LegalBookKind.SALES_TAXPAYERS
    )
    expect(saleBookOfDocumentType({ requiredReceiverFields: ['registrationId'] })).toBe(
      LegalBookKind.SALES_TAXPAYERS
    )
  })
  it('puts a type that asks for no tax identity in the book of consumers', () => {
    expect(saleBookOfDocumentType({ requiredReceiverFields: [] })).toBe(
      LegalBookKind.SALES_CONSUMERS
    )
    expect(saleBookOfDocumentType({ requiredReceiverFields: ['name', 'email'] })).toBe(
      LegalBookKind.SALES_CONSUMERS
    )
  })
  it('lists neither a credit note nor a type nobody declares', () => {
    expect(
      saleBookOfDocumentType({ creditNote: true, requiredReceiverFields: ['taxId'] })
    ).toBeNull()
    expect(saleBookOfDocumentType(null)).toBeNull()
  })
})
