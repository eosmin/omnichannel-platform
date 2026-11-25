import {
  LegalBookCorrelativeRestart,
  LegalBookField,
  LegalBookFieldsOfKind,
  LegalBookKind,
  LegalBookLimits,
  LegalBookMoneyFields,
  LegalBookSort,
  LegalBookUnissuedSales,
  TaxIdentityReceiverFields
} from '@platform/core/domain'

// The legal books (TDD_18 §7, §13 row 6; Step 4B.8b-3), pure. **[ACCOUNTANT]** A legal book is a read-only report over the ledger: a row
// per source, the columns, the order and the correlative of the organization's own layout. What the law asks of each book (which
// columns, in what order, how the numbers run) is the accountant's call and is NOT decided here: `proposedLayout` is a starting point
// that nobody has validated, and every book built from it says so (`source: 'proposal'`). A book is a function of its sources and its
// layout, with no clock and no randomness, so the book of a closed month is the same bytes every time it is asked for.

export type BookCell = string | number | boolean | null

export interface BookColumn {
  readonly field: LegalBookField
  // The header of the column in the file: the organization's own text (it may be the legal name of the column); the field when null
  readonly label: string | null
}

export interface LegalBookLayout {
  readonly columns: readonly BookColumn[]
  readonly sort: LegalBookSort
  readonly correlativeStart: number
  readonly correlativeRestart: LegalBookCorrelativeRestart
  // How a sale with no fiscal document is listed (only the book of the final consumers reads it)
  readonly unissuedSales: LegalBookUnissuedSales
}

// What a book is built from: one row per source with the value of each field it can show. The dates are calendar days (`YYYY-MM-DD`).
export interface BookSourceRow {
  readonly entryNumber: number
  readonly entryDate: string
  // The number of the document of the source, for the sort by document; empty when it has none
  readonly documentNumber: string
  readonly values: Readonly<Partial<Record<LegalBookField, BookCell>>>
}

export interface LegalBook {
  readonly kind: LegalBookKind
  readonly header: readonly string[]
  readonly rows: readonly (readonly BookCell[])[]
  // The sum of every money column, by field, in whole cents
  readonly totals: Readonly<Partial<Record<LegalBookField, number>>>
}

const column = (field: LegalBookField, label: string | null = null): BookColumn => ({
  field,
  label
})

// THE PROPOSAL, **propuesta sin validar por el contador** (unvalidated by the accountant): the columns a book of this kind plausibly needs, with the field names as headers. It is not the format
// of any country's law. The accountant replaces it (a stored layout, with their confirmation) before a book is relied on.
export const PROPOSED_BOOK_COLUMNS: Readonly<Record<LegalBookKind, readonly BookColumn[]>> = {
  [LegalBookKind.SALES_TAXPAYERS]: [
    column(LegalBookField.CORRELATIVE),
    column(LegalBookField.DATE),
    column(LegalBookField.DOCUMENT_TYPE),
    column(LegalBookField.DOCUMENT_NUMBER),
    column(LegalBookField.SOURCE_NUMBER),
    column(LegalBookField.BASE_EXEMPT),
    column(LegalBookField.BASE_NOT_SUBJECT),
    column(LegalBookField.BASE_TAXED),
    column(LegalBookField.BASE_SHIPPING_UNTAXED),
    column(LegalBookField.TAX),
    column(LegalBookField.TOTAL)
  ],
  [LegalBookKind.SALES_CONSUMERS]: [
    column(LegalBookField.CORRELATIVE),
    column(LegalBookField.DATE),
    column(LegalBookField.DOCUMENT_TYPE),
    column(LegalBookField.DOCUMENT_NUMBER),
    column(LegalBookField.SOURCE_NUMBER),
    column(LegalBookField.BASE_EXEMPT),
    column(LegalBookField.BASE_NOT_SUBJECT),
    column(LegalBookField.BASE_TAXED),
    column(LegalBookField.BASE_SHIPPING_UNTAXED),
    column(LegalBookField.TAX),
    column(LegalBookField.TOTAL)
  ],
  [LegalBookKind.PURCHASES]: [
    column(LegalBookField.CORRELATIVE),
    column(LegalBookField.DATE),
    column(LegalBookField.DOCUMENT_NUMBER),
    column(LegalBookField.SUPPLIER_NAME),
    column(LegalBookField.SUPPLIER_TAX_ID),
    column(LegalBookField.BASE),
    column(LegalBookField.TAX),
    column(LegalBookField.TOTAL),
    column(LegalBookField.TAX_CREDITABLE)
  ]
}

// The proposal of a kind of book. A country's template may carry its own later, with no change here; today there is one for all
export function proposedLayout(kind: LegalBookKind): LegalBookLayout {
  return {
    columns: PROPOSED_BOOK_COLUMNS[kind],
    sort: LegalBookSort.DATE,
    correlativeStart: 1,
    correlativeRestart: LegalBookCorrelativeRestart.MONTH,
    unissuedSales: LegalBookUnissuedSales.CONSUMERS
  }
}

export enum LegalBookLayoutProblem {
  NO_COLUMNS = 'no_columns',
  TOO_MANY_COLUMNS = 'too_many_columns',
  FIELD_NOT_OF_BOOK = 'field_not_of_book',
  FIELD_REPEATED = 'field_repeated',
  LABEL_NOT_VALID = 'label_not_valid',
  CORRELATIVE_START_NOT_VALID = 'correlative_start_not_valid',
  // A correlative that runs through the year cannot follow the order of the documents: a row's number would depend on the month asked for
  SORT_BREAKS_YEARLY_CORRELATIVE = 'sort_breaks_yearly_correlative'
}

// What is wrong with a layout for a kind of book, or null. A layout can ask only for the fields of its kind (a closed list: no customer
// data and nothing else is reachable from a layout), once each, with a label that is one line of text.
export function layoutProblem(
  kind: LegalBookKind,
  layout: LegalBookLayout
): LegalBookLayoutProblem | null {
  if (layout.columns.length === 0) return LegalBookLayoutProblem.NO_COLUMNS
  if (layout.columns.length > LegalBookLimits.MAX_COLUMNS) {
    return LegalBookLayoutProblem.TOO_MANY_COLUMNS
  }
  const allowed = new Set<LegalBookField>(LegalBookFieldsOfKind[kind])
  const seen = new Set<LegalBookField>()
  for (const { field, label } of layout.columns) {
    if (!allowed.has(field)) return LegalBookLayoutProblem.FIELD_NOT_OF_BOOK
    if (seen.has(field)) return LegalBookLayoutProblem.FIELD_REPEATED
    seen.add(field)
    if (
      label !== null &&
      (label.length === 0 ||
        label.length > LegalBookLimits.LABEL_MAX_LENGTH ||
        /[\r\n\t]/.test(label))
    ) {
      return LegalBookLayoutProblem.LABEL_NOT_VALID
    }
  }
  if (
    !Number.isInteger(layout.correlativeStart) ||
    layout.correlativeStart < 1 ||
    layout.correlativeStart > LegalBookLimits.CORRELATIVE_START_MAX
  ) {
    return LegalBookLayoutProblem.CORRELATIVE_START_NOT_VALID
  }
  if (
    layout.sort === LegalBookSort.DOCUMENT &&
    layout.correlativeRestart === LegalBookCorrelativeRestart.YEAR
  ) {
    return LegalBookLayoutProblem.SORT_BREAKS_YEARLY_CORRELATIVE
  }
  return null
}

// The first day of the stretch the correlative runs over: the month or the year of a day
export function correlativeBucketStart(day: string, restart: LegalBookCorrelativeRestart): string {
  return restart === LegalBookCorrelativeRestart.YEAR
    ? `${day.slice(0, 4)}-01-01`
    : `${day.slice(0, 7)}-01`
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// Document numbers compare the way people read them (9 before 10) and a row with no document goes last, so the order follows the sequence
const compareDocument = (a: string, b: string): number =>
  a === b
    ? 0
    : a === ''
      ? 1
      : b === ''
        ? -1
        : a.localeCompare(b, 'en', { numeric: true }) || compareText(a, b)

// The order of the rows of a book: always total (the number of the entry breaks every tie), so the same sources give the same book
export function compareBookRows(
  sort: LegalBookSort
): (a: BookSourceRow, b: BookSourceRow) => number {
  return (a, b) =>
    sort === LegalBookSort.DOCUMENT
      ? compareDocument(a.documentNumber, b.documentNumber) ||
        compareText(a.entryDate, b.entryDate) ||
        a.entryNumber - b.entryNumber
      : compareText(a.entryDate, b.entryDate) || a.entryNumber - b.entryNumber
}

// The book of a range of days. `sources` hold every row from the start of the stretch the correlative runs over (the month, or the year,
// of `from`) to `to`, so a correlative that runs through a year is the same whatever month is asked for; the rows before `from` are
// numbered and dropped. The correlative of a row is the start of the layout plus the rows before it in its stretch.
export function buildLegalBook(
  kind: LegalBookKind,
  layout: LegalBookLayout,
  sources: readonly BookSourceRow[],
  range: { from: string; to: string }
): LegalBook {
  const ordered = [...sources].sort(compareBookRows(layout.sort))
  const counters = new Map<string, number>()
  const rows: BookCell[][] = []
  const totals: Partial<Record<LegalBookField, number>> = {}
  const money = new Set<LegalBookField>(LegalBookMoneyFields)
  for (const source of ordered) {
    const bucket = correlativeBucketStart(source.entryDate, layout.correlativeRestart)
    const position = counters.get(bucket) ?? 0
    counters.set(bucket, position + 1)
    if (source.entryDate < range.from || source.entryDate > range.to) continue
    const correlative = layout.correlativeStart + position
    const cells = layout.columns.map(({ field }): BookCell => {
      if (field === LegalBookField.CORRELATIVE) return correlative
      if (field === LegalBookField.DATE) return source.entryDate
      if (field === LegalBookField.ENTRY_NUMBER) return source.entryNumber
      return source.values[field] ?? null
    })
    rows.push(cells)
    for (const [index, { field }] of layout.columns.entries()) {
      const cell = cells[index]
      if (money.has(field) && typeof cell === 'number') totals[field] = (totals[field] ?? 0) + cell
    }
  }
  return {
    kind,
    header: layout.columns.map(item => item.label ?? item.field),
    rows,
    totals
  }
}

// Which book a fiscal document of a sale belongs to, read from what the provider that built it declares of its type (the fields of the
// receiver the type cannot be built without), never from the name of a type: a type that asks for the receiver's tax identity is a sale
// to a taxpayer, any other is a sale to a final consumer, and a credit note is neither (it cancels another document). Null when the
// provider or the type is not one this deployment knows: the sale is then counted apart, not guessed. **[ACCOUNTANT]** confirms the rule.
export interface DocumentTypeDeclaration {
  readonly creditNote?: boolean
  // A debit note charges more on a sale document: it is listed like the document of a sale to its receiver, never apart
  readonly debitNote?: boolean
  readonly requiredReceiverFields: readonly string[]
}

export function saleBookOfDocumentType(
  declaration: DocumentTypeDeclaration | null
): LegalBookKind.SALES_TAXPAYERS | LegalBookKind.SALES_CONSUMERS | null {
  if (declaration === null || declaration.creditNote === true) return null
  return declaration.requiredReceiverFields.some(field => TaxIdentityReceiverFields.includes(field))
    ? LegalBookKind.SALES_TAXPAYERS
    : LegalBookKind.SALES_CONSUMERS
}
