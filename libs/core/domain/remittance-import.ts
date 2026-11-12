import { RemittanceLimits } from './remittance-rules'
import { plainName } from './text'

// The deterministic reading of a carrier's settlement file (TDD_17 §4.15): a CSV or TSV file or a table pasted as text, read with
// the saved mapping of the carrier. No AI, no guessing of a locale, no formula evaluated: a cell is text, and a cell that is not
// what its column says becomes a visible row error and is never read as zero. Pure: the service reads the file and writes.

export const RemittanceImportLimits = {
  MAX_BYTES: 5 * 1024 * 1024,
  MAX_ROWS: RemittanceLimits.MAX_LINES,
  // The preview of the mapper reads a sample, not the file
  // The sample travels as JSON, whose body the app reads up to 100 KB, with the escapes of line breaks and quotes
  PREVIEW_MAX_BYTES: 32 * 1024,
  PREVIEW_ROWS: 20,
  // The row errors an answer names (the count of all of them is always given)
  MAX_ERRORS_REPORTED: 100,
  // How much of a bad cell an error repeats: enough to find it, never a page of text
  ERROR_VALUE_MAX_LENGTH: 40
} as const

export const RemittanceDelimiters = { COMMA: ',', SEMICOLON: ';', TAB: '\t' } as const
export type RemittanceDelimiter = (typeof RemittanceDelimiters)[keyof typeof RemittanceDelimiters]

export const RemittanceDecimalSeparators = { DOT: '.', COMMA: ',' } as const
export type RemittanceDecimalSeparator =
  (typeof RemittanceDecimalSeparators)[keyof typeof RemittanceDecimalSeparators]

export const RemittanceDateFormats = {
  ISO: 'yyyy-MM-dd',
  DAY_FIRST_SLASH: 'dd/MM/yyyy',
  MONTH_FIRST_SLASH: 'MM/dd/yyyy',
  DAY_FIRST_DASH: 'dd-MM-yyyy'
} as const
export type RemittanceDateFormat =
  (typeof RemittanceDateFormats)[keyof typeof RemittanceDateFormats]

// How the file is kept and named (the content type of what was sent decides the extension of the copy that is kept)
export const RemittanceImportFiles = {
  CSV: { contentType: 'text/csv', extension: 'csv' },
  TSV: { contentType: 'text/tab-separated-values', extension: 'tsv' },
  PLAIN: { contentType: 'text/plain', extension: 'txt' },
  FILENAME_PREFIX: 'remittance'
} as const

// The values a mapping can point at
export const RemittanceImportFields = {
  GUIDE_NUMBER: 'guideNumber',
  AMOUNT: 'amount',
  FEE: 'fee',
  DATE: 'date',
  REFERENCE: 'reference'
} as const
export type RemittanceImportField =
  (typeof RemittanceImportFields)[keyof typeof RemittanceImportFields]

// Why a row, or the mapping, was refused: the closed list a screen translates
export const RemittanceImportErrors = {
  // The mapping names a header the file does not have, or a position past the end of a row
  COLUMN_NOT_FOUND: 'column_not_found',
  // The row has fewer cells than the column asks for
  MISSING_CELL: 'missing_cell',
  EMPTY_VALUE: 'empty_value',
  INVALID_AMOUNT: 'invalid_amount',
  INVALID_DATE: 'invalid_date',
  INVALID_TEXT: 'invalid_text',
  TOO_MANY_ROWS: 'too_many_rows',
  EMPTY_FILE: 'empty_file',
  UNCLOSED_QUOTE: 'unclosed_quote',
  // A row has more cells than the header: an unquoted delimiter inside a cell moved the columns
  ROW_TOO_WIDE: 'row_too_wide'
} as const
export type RemittanceImportError =
  (typeof RemittanceImportErrors)[keyof typeof RemittanceImportErrors]

// A column is named by the text of its header or by its position (0 is the first)
export type RemittanceColumnRef = string | number

export interface RemittanceImportMapping {
  guideNumber: RemittanceColumnRef
  amount: RemittanceColumnRef
  fee?: RemittanceColumnRef | undefined
  date?: RemittanceColumnRef | undefined
  reference?: RemittanceColumnRef | undefined
}

export interface RemittanceImportProfileShape {
  delimiter: RemittanceDelimiter
  hasHeader: boolean
  decimalSeparator: RemittanceDecimalSeparator
  dateFormat: RemittanceDateFormat
  columns: RemittanceImportMapping
}

export interface ImportRowError {
  // 1-based position of the row in the file, counting the header
  row: number
  // The value that was being read, or null for an error of the whole mapping
  field: RemittanceImportField | null
  code: RemittanceImportError
  // What the cell said, bounded and without line breaks
  value: string | null
}

export interface ImportedLine {
  guideNumber: string
  reportedCents: number
  reportedFeeCents?: number
  // 1-based position of the row in the file
  row: number
}

export interface ParsedRemittanceFile {
  headers: string[]
  lines: ImportedLine[]
  errors: ImportRowError[]
  // How many errors there are (`errors` holds the first ones only)
  errorCount: number
  // The rows with data that were read, good or bad
  rowCount: number
  // The one settlement number and the one day that every row that names one agrees on, else null
  reference: string | null
  receivedOn: string | null
}

// ------------------------------------------------------------------------------------------------------ the cells

// CSV as RFC 4180 says it: quoted cells may hold the delimiter, a doubled quote and line breaks; a line break ends a row. A BOM is
// not part of the first cell. Returns the rows, and whether a quote was left open at the end.
export function splitDelimited(
  text: string,
  delimiter: RemittanceDelimiter
): { rows: string[][]; lines: number[]; unclosedQuote: boolean; openLine: number } {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const rows: string[][] = []
  // The line of the file where each row starts, as an editor counts them: a line break inside a quoted cell counts too
  const lines: number[] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let touched = false
  let line = 1
  let rowLine = 1
  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    lines.push(rowLine)
    row = []
    touched = false
    rowLine = line
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (quoted) {
      if (char === '"') {
        if (source.charAt(index + 1) === '"') {
          cell += '"'
          index += 1
        } else quoted = false
      } else {
        if (char === '\n' || (char === '\r' && source.charAt(index + 1) !== '\n')) line += 1
        cell += char
      }
      continue
    }
    if (char === '"' && cell === '') {
      quoted = true
      touched = true
    } else if (char === delimiter) {
      endCell()
      touched = true
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source.charAt(index + 1) === '\n') index += 1
      line += 1
      endRow()
    } else {
      cell += char
      touched = true
    }
  }
  if (quoted) return { rows, lines, unclosedQuote: true, openLine: rowLine }
  if (touched || cell !== '') endRow()
  return { rows, lines, unclosedQuote: false, openLine: rowLine }
}

// One pattern for each decimal separator, built once
const MONEY_PATTERNS: Record<RemittanceDecimalSeparator, RegExp> = {
  [RemittanceDecimalSeparators.DOT]: /^(\d{1,12})(?:\.(\d{1,2}))?$/,
  [RemittanceDecimalSeparators.COMMA]: /^(\d{1,12})(?:,(\d{1,2}))?$/
}

// Digits with at most one decimal separator and at most two decimals: "12", "12.5", "12.50" (or with the comma, when the profile
// says so). No sign, no currency symbol, no thousands separator, no exponent, no spaces inside: a cell that is anything else is
// refused, so that "1,234.50" is never read as 1.23 and "abc" is never read as 0. Returns whole cents, or null.
export function parseMoneyCents(
  cell: string,
  decimalSeparator: RemittanceDecimalSeparator
): number | null {
  const match = MONEY_PATTERNS[decimalSeparator].exec(cell.trim())
  if (match === null) return null
  const whole = Number(match[1])
  const cents = whole * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents <= RemittanceLimits.MAX_AMOUNT_CENTS ? cents : null
}

const DATE_PATTERNS: Record<
  RemittanceDateFormat,
  { pattern: RegExp; order: [number, number, number] }
> = {
  // The order says where the year, the month and the day are among the captured groups
  [RemittanceDateFormats.ISO]: { pattern: /^(\d{4})-(\d{2})-(\d{2})$/, order: [1, 2, 3] },
  [RemittanceDateFormats.DAY_FIRST_SLASH]: {
    pattern: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    order: [3, 2, 1]
  },
  [RemittanceDateFormats.MONTH_FIRST_SLASH]: {
    pattern: /^(\d{2})\/(\d{2})\/(\d{4})$/,
    order: [3, 1, 2]
  },
  [RemittanceDateFormats.DAY_FIRST_DASH]: { pattern: /^(\d{2})-(\d{2})-(\d{4})$/, order: [3, 2, 1] }
}

// A day that exists, in the format of the profile, as 'yyyy-MM-dd'; null otherwise ('31/02/2026' is not a day)
export function parseImportDay(cell: string, format: RemittanceDateFormat): string | null {
  const rule = DATE_PATTERNS[format]
  const match = rule.pattern.exec(cell.trim())
  if (match === null) return null
  const year = match[rule.order[0]] ?? ''
  const month = match[rule.order[1]] ?? ''
  const day = match[rule.order[2]] ?? ''
  // A year a settlement can have: JS reads 0000 and Postgres refuses it, so the range is closed here
  if (Number(year) < 1970 || Number(year) > 2100) return null
  const iso = `${year}-${month}-${day}`
  const parsed = new Date(`${iso}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(iso) ? iso : null
}

// A guide number or a reference: one visible line. Control characters and invisible ones are refused (a tab or a zero-width
// space would make two guides that look the same different), and the text is only ever stored, never rendered as markup.
const CONTROL_OR_INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u
function cleanText(cell: string, maxLength: number): string | null {
  // As a guide typed by hand is kept (NFC, one space between words), so that the same guide is one string whichever way it came
  const text = plainName(cell)
  if (text === '' || text.length > maxLength || CONTROL_OR_INVISIBLE.test(text)) return null
  return text
}

function shown(cell: string): string {
  const flat = cell.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim()
  return flat.length > RemittanceImportLimits.ERROR_VALUE_MAX_LENGTH
    ? `${flat.slice(0, RemittanceImportLimits.ERROR_VALUE_MAX_LENGTH)}…`
    : flat
}

// ------------------------------------------------------------------------------------------------------ the file

// A header is compared as the mapping was saved: NFC, one space between words, no case
export function headerKey(header: string): string {
  return plainName(header).toLowerCase()
}

function resolveColumn(
  ref: RemittanceColumnRef | undefined,
  headers: readonly string[],
  hasHeader: boolean,
  width: number
): number | null | undefined {
  if (ref === undefined) return undefined
  if (typeof ref === 'number') return ref < width ? ref : null
  if (!hasHeader) return null
  const wanted = headerKey(ref)
  const found = headers.findIndex(header => headerKey(header) === wanted)
  return found === -1 ? null : found
}

// Reads the whole text with the profile. Every problem is returned, none is thrown: the file is accepted only when `errorCount`
// is 0. `maxRows` bounds the rows read (the preview reads a few).
export function parseRemittanceFile(
  text: string,
  profile: RemittanceImportProfileShape,
  options: { maxRows?: number } = {}
): ParsedRemittanceFile {
  const maxRows = options.maxRows ?? RemittanceImportLimits.MAX_ROWS
  const errors: ImportRowError[] = []
  let errorCount = 0
  const fail = (
    row: number,
    field: RemittanceImportField | null,
    code: RemittanceImportError,
    value: string | null
  ) => {
    errorCount += 1
    if (errors.length < RemittanceImportLimits.MAX_ERRORS_REPORTED)
      errors.push({ row, field, code, value })
  }
  const empty: ParsedRemittanceFile = {
    headers: [],
    lines: [],
    errors,
    errorCount: 0,
    rowCount: 0,
    reference: null,
    receivedOn: null
  }
  const {
    rows,
    lines: startLines,
    unclosedQuote,
    openLine
  } = splitDelimited(text, profile.delimiter)
  if (unclosedQuote) {
    fail(openLine, null, RemittanceImportErrors.UNCLOSED_QUOTE, null)
    return { ...empty, errorCount }
  }
  // Each row with the line of the file where it starts (empty lines are counted and then skipped)
  const body = rows
    .map((cells, index) => ({ cells, line: startLines[index] ?? index + 1 }))
    .filter(entry => entry.cells.some(cell => cell.trim() !== ''))
  if (body.length === 0) {
    fail(1, null, RemittanceImportErrors.EMPTY_FILE, null)
    return { ...empty, errorCount }
  }
  const headerRow = profile.hasHeader ? (body[0]?.cells ?? []) : []
  const data = profile.hasHeader ? body.slice(1) : body
  if (profile.hasHeader && body.length > 0 && data.length === 0) {
    fail(1, null, RemittanceImportErrors.EMPTY_FILE, null)
  }
  if (data.length > RemittanceImportLimits.MAX_ROWS) {
    // Said at once: a file of millions of rows is not read any further
    fail(
      data[RemittanceImportLimits.MAX_ROWS]?.line ?? 1,
      null,
      RemittanceImportErrors.TOO_MANY_ROWS,
      String(data.length)
    )
    return { ...empty, headers: headerRow, errorCount }
  }
  // Where each value is. A row of the file is as wide as the widest one for the positions
  let width = headerRow.length
  for (const entry of data) if (entry.cells.length > width) width = entry.cells.length
  const columns: Partial<Record<RemittanceImportField, number>> = {}
  const mapping: [RemittanceImportField, RemittanceColumnRef | undefined, boolean][] = [
    [RemittanceImportFields.GUIDE_NUMBER, profile.columns.guideNumber, true],
    [RemittanceImportFields.AMOUNT, profile.columns.amount, true],
    [RemittanceImportFields.FEE, profile.columns.fee, false],
    [RemittanceImportFields.DATE, profile.columns.date, false],
    [RemittanceImportFields.REFERENCE, profile.columns.reference, false]
  ]
  for (const [field, ref, required] of mapping) {
    const index = resolveColumn(ref, headerRow, profile.hasHeader, width)
    if (index === null) {
      fail(
        profile.hasHeader ? 1 : 0,
        field,
        RemittanceImportErrors.COLUMN_NOT_FOUND,
        ref === undefined ? null : shown(String(ref))
      )
    } else if (index !== undefined) columns[field] = index
    else if (required) fail(0, field, RemittanceImportErrors.COLUMN_NOT_FOUND, null)
  }
  const lines: ImportedLine[] = []
  const references = new Set<string>()
  const days = new Set<string>()
  let rowCount = 0
  if (errorCount > 0 && (columns.guideNumber === undefined || columns.amount === undefined)) {
    return {
      headers: headerRow,
      lines,
      errors,
      errorCount,
      rowCount,
      reference: null,
      receivedOn: null
    }
  }
  for (const { cells, line: row } of data.slice(0, maxRows)) {
    rowCount += 1
    const before = errorCount
    // A row with more cells than the header has is a cell with an unquoted delimiter in it: the columns after it moved, so no
    // amount of this row can be trusted
    // (cells that are empty past the header, a trailing delimiter, move nothing)
    if (profile.hasHeader && cells.slice(headerRow.length).some(extra => extra.trim() !== '')) {
      fail(row, null, RemittanceImportErrors.ROW_TOO_WIDE, String(cells.length))
      continue
    }
    const cell = (field: RemittanceImportField): string | undefined => {
      const index = columns[field]
      return index === undefined ? undefined : cells[index]
    }
    const guideCell = cell(RemittanceImportFields.GUIDE_NUMBER)
    const guide =
      guideCell === undefined
        ? (fail(
            row,
            RemittanceImportFields.GUIDE_NUMBER,
            RemittanceImportErrors.MISSING_CELL,
            null
          ),
          null)
        : guideCell.trim() === ''
          ? (fail(
              row,
              RemittanceImportFields.GUIDE_NUMBER,
              RemittanceImportErrors.EMPTY_VALUE,
              null
            ),
            null)
          : cleanText(guideCell, RemittanceLimits.GUIDE_MAX_LENGTH)
    if (guideCell !== undefined && guideCell.trim() !== '' && guide === null) {
      fail(
        row,
        RemittanceImportFields.GUIDE_NUMBER,
        RemittanceImportErrors.INVALID_TEXT,
        shown(guideCell)
      )
    }
    const amountCell = cell(RemittanceImportFields.AMOUNT)
    let amount: number | null = null
    if (amountCell === undefined)
      fail(row, RemittanceImportFields.AMOUNT, RemittanceImportErrors.MISSING_CELL, null)
    else if (amountCell.trim() === '')
      fail(row, RemittanceImportFields.AMOUNT, RemittanceImportErrors.EMPTY_VALUE, null)
    else {
      amount = parseMoneyCents(amountCell, profile.decimalSeparator)
      if (amount === null)
        fail(
          row,
          RemittanceImportFields.AMOUNT,
          RemittanceImportErrors.INVALID_AMOUNT,
          shown(amountCell)
        )
    }
    const feeCell = cell(RemittanceImportFields.FEE)
    let fee: number | null = null
    if (feeCell !== undefined && feeCell.trim() !== '') {
      fee = parseMoneyCents(feeCell, profile.decimalSeparator)
      if (fee === null)
        fail(row, RemittanceImportFields.FEE, RemittanceImportErrors.INVALID_AMOUNT, shown(feeCell))
    }
    const dateCell = cell(RemittanceImportFields.DATE)
    if (dateCell !== undefined && dateCell.trim() !== '') {
      const day = parseImportDay(dateCell, profile.dateFormat)
      if (day === null)
        fail(row, RemittanceImportFields.DATE, RemittanceImportErrors.INVALID_DATE, shown(dateCell))
      else days.add(day)
    }
    const referenceCell = cell(RemittanceImportFields.REFERENCE)
    if (referenceCell !== undefined && referenceCell.trim() !== '') {
      const reference = cleanText(referenceCell, RemittanceLimits.REFERENCE_MAX_LENGTH)
      if (reference === null)
        fail(
          row,
          RemittanceImportFields.REFERENCE,
          RemittanceImportErrors.INVALID_TEXT,
          shown(referenceCell)
        )
      else references.add(reference)
    }
    if (errorCount === before && guide !== null && amount !== null) {
      lines.push({
        guideNumber: guide,
        reportedCents: amount,
        row,
        ...(fee === null ? {} : { reportedFeeCents: fee })
      })
    }
  }
  return {
    headers: headerRow,
    lines,
    errors,
    errorCount,
    rowCount,
    reference: references.size === 1 ? ([...references][0] ?? null) : null,
    receivedOn: days.size === 1 ? ([...days][0] ?? null) : null
  }
}
