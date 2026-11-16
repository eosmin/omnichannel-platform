import type {
  FinanceBookCell,
  FinanceBookLayoutView,
  FinanceBookView,
  FinanceBookWarningsView
} from '@platform/api-client'
import {
  LegalBookCorrelativeRestart,
  LegalBookField,
  LegalBookKind,
  LegalBookLayoutSource,
  LegalBookMoneyFields,
  LegalBookSort,
  LegalBookUnissuedSales
} from '@platform/core/domain'

// What the page of the legal books reads from a book. **[ACCOUNTANT]** Nothing here decides a layout: the columns, their order and their
// headers are the organization's data, and the money columns are the ones the api totals (`LegalBookMoneyFields`).

const MONEY_FIELDS: ReadonlySet<string> = new Set(LegalBookMoneyFields)

export interface BookColumnInfo {
  // The field of the column when the screen knows it; null when it can only be guessed from the header and the guess says nothing
  field: string | null
  money: boolean
}

// Which column of a book is which field. The book carries the headers (the organization's own labels) and not the fields, so the fields
// come from the layout of the same version when the layout list holds it (the latest one); for any other version a header that is a field
// name (the proposal writes them that way) says it itself. A column that cannot be told is drawn as plain text, never as an amount.
export function bookColumns(
  book: Pick<FinanceBookView, 'header' | 'layout'>,
  layouts: readonly FinanceBookLayoutView[] | undefined,
  kind: string
): BookColumnInfo[] {
  const layout = layouts?.find(item => item.kind === kind && item.version === book.layout.version)
  const fromLayout = layout !== undefined && layout.columns.length === book.header.length
  return book.header.map((header, index) => {
    const field = fromLayout
      ? (layout.columns[index]?.field ?? null)
      : MONEY_FIELDS.has(header)
        ? header
        : null
    return { field, money: field !== null && MONEY_FIELDS.has(field) }
  })
}

// Whether the screen could tell which columns are money. A book that totals something and shows no column it can call money (a frozen
// book of an older layout version, whose fields the layout list no longer holds, with headers the organization renamed) is drawn as plain
// numbers, and the page says the figures are whole cents instead of leaving them to look like dollars.
export const moneyColumnsAreKnown = (
  columns: readonly BookColumnInfo[],
  totals: Readonly<Record<string, number>>
): boolean => Object.keys(totals).length === 0 || columns.some(column => column.money)

// A cell of a money column is whole cents; a cell that is not a whole number is shown as the api wrote it, never rounded
export const isCentsCell = (cell: FinanceBookCell): cell is number =>
  typeof cell === 'number' && Number.isSafeInteger(cell)

// The totals row: the sum the api computed for each money column, and nothing for the others
export function totalCells(
  columns: readonly BookColumnInfo[],
  totals: Readonly<Record<string, number>>
): (number | null)[] {
  return columns.map(column =>
    column.money && column.field !== null ? (totals[column.field] ?? null) : null
  )
}

// The warnings of a book that are not zero, in the order the page shows them; `finance.books.warnings.<key>`
const WARNING_ORDER = [
  'salesWithoutTaxSnapshot',
  'salesNotReadable',
  'voidedDocuments',
  'unclassifiedDocuments',
  'returnsNotListed'
] as const satisfies readonly (keyof FinanceBookWarningsView)[]

export function bookWarnings(
  warnings: FinanceBookWarningsView
): { key: (typeof WARNING_ORDER)[number]; count: number }[] {
  return WARNING_ORDER.filter(key => warnings[key] > 0).map(key => ({
    key,
    count: warnings[key]
  }))
}

// The name of a downloaded book: readable, with the kind and the month; a book that is still a draft says so in the name of its file (the
// word is the language of the person: `draftTag`), so a file taken for the proposal is never filed as the legal book
export const bookFileName = (
  kind: string,
  period: { year: number; month: number },
  draftTag: string | null
): string =>
  `${kind}-${String(period.year)}-${String(period.month).padStart(2, '0')}${draftTag === null ? '' : `-${draftTag}`}.csv`

// The rows a book draws on screen: the file has them all. A month of sales is thousands of rows; drawing every one makes the page slow,
// and the total row and the count always say what is left out
export const BOOK_ROWS_SHOWN = 200

// The closed lists a book and its layout speak in, as lookups that no member of Object.prototype can answer: a value the screen does not
// know (a newer api) is null, and the page shows it as it came
const closed = <E extends string>(values: Record<string, E>): ((value: string) => E | null) => {
  const map = new Map(Object.values(values).map(item => [item as string, item]))
  return value => map.get(value) ?? null
}
export const legalBookKindOf = closed<LegalBookKind>(LegalBookKind)
export const legalBookFieldOf = closed<LegalBookField>(LegalBookField)
export const layoutSourceOf = closed<LegalBookLayoutSource>(LegalBookLayoutSource)
export const layoutSortOf = closed<LegalBookSort>(LegalBookSort)
export const layoutRestartOf = closed<LegalBookCorrelativeRestart>(LegalBookCorrelativeRestart)
export const layoutUnissuedOf = closed<LegalBookUnissuedSales>(LegalBookUnissuedSales)
