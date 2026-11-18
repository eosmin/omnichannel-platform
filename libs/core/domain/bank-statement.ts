import { FinanceLimits } from './finance-constants'
import {
  cleanImportText as cleanText,
  headerKey,
  dayOrderEvidence,
  parseImportMoment,
  splitMoment,
  resolveImportColumn as resolveColumn,
  shownImportValue as shown,
  widthOfMostImportRows as widthOfMostRows,
  RemittanceDateFormats,
  RemittanceDelimiters,
  type RemittanceDateFormat,
  type RemittanceDecimalSeparator,
  type RemittanceDelimiter,
  splitDelimited
} from './remittance-import'
import { plainText } from './text'
import { DAY_MS } from './time-constants'

// The deterministic reading of the CSV a bank gives (TDD_18 §4.4) and the matching of its lines with the books. No AI, no connection
// to a bank, no locale guessed, no formula evaluated: a cell is text, and a cell that is not what its column says is a visible row
// error and is never read as zero. Pure: the service reads the file, keeps it and writes. [ACCOUNTANT] / the owner configure the
// columns, the formats and the window of dates of each bank in a saved profile; nothing about a bank is built in.

export const BankStatementLimits = {
  MAX_BYTES: 5 * 1024 * 1024,
  MAX_ROWS: 5000,
  // The preview of the mapper reads a sample, not the file (it travels as JSON, whose body the app reads up to 100 KB)
  PREVIEW_MAX_BYTES: 32 * 1024,
  PREVIEW_ROWS: 20,
  MAX_ERRORS_REPORTED: 100,
  REFERENCE_MAX_LENGTH: 100,
  DESCRIPTION_MAX_LENGTH: 300,
  // A cent amount of a line is an Int of the database, like every amount of the books
  MAX_AMOUNT_CENTS: FinanceLimits.MAX_LINE_CENTS,
  // The days a statement line and a book line may be apart and still be suggested (the profile's own choice)
  DATE_WINDOW_DEFAULT_DAYS: 3,
  DATE_WINDOW_MAX_DAYS: 31,
  // A reference shorter than this says nothing ("1" is inside every number): it never makes a match "exact"
  REFERENCE_MIN_MATCH_LENGTH: 4,
  MAX_PROFILES_PER_ACCOUNT: 20,
  // The records a profile may skip at the start of a file (the lead of report lines some banks print before the movements)
  SKIP_ROWS_MAX: 50,
  // A column of a profile: the text of its header, or its position (0 is the first column)
  COLUMN_HEADER_MAX_LENGTH: 80,
  COLUMN_POSITION_MAX: 200,
  PROFILE_NAME_MAX_LENGTH: 80,
  // A page of statement lines, and how many suggestions one line shows
  MAX_SUGGESTIONS_PER_LINE: 5,
  // The most statement lines one bulk confirmation settles
  MAX_BULK_CONFIRM: 1000
} as const

// How the bytes of the file become text. A bank of the region may still send Latin-1 (Windows-1252): the profile says so, nothing is guessed.
export const BankStatementEncodings = { UTF8: 'utf-8', WINDOWS_1252: 'windows-1252' } as const
export type BankStatementEncoding =
  (typeof BankStatementEncodings)[keyof typeof BankStatementEncodings]

// The thousands separator a bank prints inside an amount ("1,234.50"): none unless the profile says so
export const BankThousandsSeparators = {
  NONE: 'none',
  COMMA: 'comma',
  DOT: 'dot',
  SPACE: 'space'
} as const
export type BankThousandsSeparator =
  (typeof BankThousandsSeparators)[keyof typeof BankThousandsSeparators]
const THOUSANDS_CHARACTER: Record<BankThousandsSeparator, string | null> = {
  none: null,
  comma: ',',
  dot: '.',
  space: ' '
}

// How the file is kept and named (the delimiter decides the extension of the copy that is kept)
export const BankStatementFiles = {
  CSV: { contentType: 'text/csv', extension: 'csv' },
  TSV: { contentType: 'text/tab-separated-values', extension: 'tsv' },
  FILENAME_PREFIX: 'bank-statement'
} as const

export const BankStatementFields = {
  DATE: 'date',
  DESCRIPTION: 'description',
  REFERENCE: 'reference',
  AMOUNT: 'amount',
  DEBIT: 'debit',
  CREDIT: 'credit'
} as const
export type BankStatementField = (typeof BankStatementFields)[keyof typeof BankStatementFields]

// Why a row, or the mapping, was refused: the closed list a screen translates
export const BankStatementErrors = {
  COLUMN_NOT_FOUND: 'column_not_found',
  COLUMN_AMBIGUOUS: 'column_ambiguous',
  COLUMN_REUSED: 'column_reused',
  MISSING_CELL: 'missing_cell',
  EMPTY_VALUE: 'empty_value',
  INVALID_AMOUNT: 'invalid_amount',
  INVALID_DATE: 'invalid_date',
  INVALID_TEXT: 'invalid_text',
  // Debit and credit columns: a row that fills both, or neither, does not say which way the money went
  AMBIGUOUS_DIRECTION: 'ambiguous_direction',
  ZERO_AMOUNT: 'zero_amount',
  TOO_MANY_ROWS: 'too_many_rows',
  EMPTY_FILE: 'empty_file',
  UNCLOSED_QUOTE: 'unclosed_quote',
  ROW_TOO_WIDE: 'row_too_wide',
  STRAY_QUOTE: 'stray_quote',
  // The profile says the file has a header and maps its columns by position, and the first row is a movement (its date reads): a
  // movement would be read as the header and lost without a word
  HEADER_LOOKS_LIKE_DATA: 'header_looks_like_data',
  // The profile skips as many rows as the file has, or more: the lead is all there is. `value` says how many rows the file has.
  SKIP_PAST_END: 'skip_past_end'
} as const
export type BankStatementError = (typeof BankStatementErrors)[keyof typeof BankStatementErrors]

export type BankColumnRef = string | number

// The money is one signed column, or one column for what came in (credit) and one for what went out (debit): never both ways
export interface BankStatementMapping {
  date: BankColumnRef
  description?: BankColumnRef | undefined
  reference?: BankColumnRef | undefined
  amount?: BankColumnRef | undefined
  debit?: BankColumnRef | undefined
  credit?: BankColumnRef | undefined
}

export interface BankStatementProfileShape {
  delimiter: RemittanceDelimiter
  hasHeader: boolean
  // How many records (rows that are not blank, a quoted line break is inside one) to drop from the start before the header or the first
  // movement: the lead of report lines some banks print. The rows keep the line of the file they are on, so an error points at it.
  skipRows: number
  decimalSeparator: RemittanceDecimalSeparator
  thousandsSeparator: BankThousandsSeparator
  dateFormat: RemittanceDateFormat
  columns: BankStatementMapping
}

export interface BankRowError {
  // 1-based line of the file where the row starts, counting the header
  row: number
  field: BankStatementField | null
  code: BankStatementError
  value: string | null
}

export interface ParsedBankLine {
  // 'yyyy-MM-dd'
  postedOn: string
  // 'HH:mm:ss' when the date of the row had a time, else null (a day alone is not midnight). It is part of the identity of the line.
  postedTime: string | null
  // Positive: money in (the bank credited the account). Negative: money out.
  amountCents: number
  description: string | null
  reference: string | null
  row: number
  // Which of the lines of the same day, amount, reference and description this one is, in file order: a statement that has two
  // identical lines is two lines, and the same file read again gives each the same number
  occurrence: number
}

export interface ParsedBankStatement {
  headers: string[]
  lines: ParsedBankLine[]
  errors: BankRowError[]
  errorCount: number
  rowCount: number
  // The dates are written with a slash and every one of them reads in both orders of the day and the month (03/11/2026): the format of
  // the profile is a guess the file cannot confirm, and a person says it before the statement is kept
  dateFormatUndecided: boolean
}

// The rules a profile keeps, written once (the schemas refuse a profile that breaks one, the service checks the one a change would
// leave): returns what is wrong, or null.
export function bankProfileProblem(value: {
  hasHeader: boolean
  delimiter: string
  decimalSeparator: string
  thousandsSeparator: string
  columns: Record<string, string | number | undefined>
}): string | null {
  const { amount, debit, credit } = value.columns
  const hasAmount = amount !== undefined
  const hasSplit = debit !== undefined || credit !== undefined
  if (hasAmount === hasSplit) {
    return 'the money is one signed column, or one column for debits and one for credits'
  }
  if (hasSplit && (debit === undefined || credit === undefined)) {
    return 'a debit column needs a credit column, and the other way round'
  }
  if (!value.hasHeader && Object.values(value.columns).some(ref => typeof ref === 'string')) {
    return 'a file with no header is mapped by column position'
  }
  const refs = Object.values(value.columns).filter(ref => ref !== undefined)
  const keys = refs.map(ref => (typeof ref === 'string' ? `h:${headerKey(ref)}` : `i:${ref}`))
  if (new Set(keys).size !== keys.length) return 'each value must be read from a column of its own'
  if (value.delimiter === value.decimalSeparator) {
    return 'the delimiter and the decimal separator must differ'
  }
  const thousands = THOUSANDS_CHARACTER[value.thousandsSeparator as BankThousandsSeparator]
  // The thousands separator may be the delimiter ("1,234.50" in a comma file): the cell is cut by the delimiter before its amount is read,
  // so a bank that quotes it is read whole, and one that does not breaks the row into more cells than the file has (a visible error).
  if (thousands !== null && thousands !== undefined && thousands === value.decimalSeparator) {
    return 'the thousands separator and the decimal separator must differ'
  }
  return null
}

// ------------------------------------------------------------------------------------------------------ the cells

// What banks put between the lines of a memo (and tabs and separators): one space of the description
// What a bank prints in the debit or credit column that does not apply to the row
// (ASCII only: an en dash, an em dash or a minus sign is still refused, the file says what it means)
const NOTHING_MARKS: ReadonlySet<string> = new Set(['-', '--'])
const LINE_BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]+/g

const escapeForPattern = (character: string): string =>
  character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const AMOUNT_PATTERNS = new Map<string, RegExp>()
function amountPattern(
  decimal: RemittanceDecimalSeparator,
  thousands: BankThousandsSeparator
): RegExp {
  const key = `${decimal}|${thousands}`
  const cached = AMOUNT_PATTERNS.get(key)
  if (cached !== undefined) return cached
  const group = THOUSANDS_CHARACTER[thousands]
  // With a thousands separator the groups must be exactly three digits: "1,23" is not an amount and is never read as one
  const whole =
    group === null ? '\\d{1,12}' : `(?:\\d{1,3}(?:${escapeForPattern(group)}\\d{3}){1,3}|\\d{1,12})`
  const pattern = new RegExp(`^([+-])?(${whole})(?:${escapeForPattern(decimal)}(\\d{1,2}))?$`)
  AMOUNT_PATTERNS.set(key, pattern)
  return pattern
}

// An amount as a bank prints it, to whole cents: an optional sign (only when `allowSign`), digits with the thousands separator of the
// profile, at most one decimal separator and at most two decimals. No currency symbol, no exponent, no parentheses, no spaces
// inside (unless the separator is a space): "abc" is never 0 and "1,234.50" is never 1.23. Returns signed cents, or null.
export function parseBankAmountCents(
  cell: string,
  decimal: RemittanceDecimalSeparator,
  thousands: BankThousandsSeparator,
  allowSign: boolean
): number | null {
  const match = amountPattern(decimal, thousands).exec(cell.trim())
  if (match === null) return null
  const sign = match[1]
  if (sign !== undefined && !allowSign) return null
  const group = THOUSANDS_CHARACTER[thousands]
  const wholeText = group === null ? (match[2] ?? '') : (match[2] ?? '').split(group).join('')
  const cents = Number(wholeText) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > BankStatementLimits.MAX_AMOUNT_CENTS) return null
  return sign === '-' ? -cents : cents
}

// ------------------------------------------------------------------------------------------------------ the file

// Reads the whole text with the profile. Every problem is returned, none is thrown: the file is accepted only when `errorCount` is 0
// (one bad row refuses the whole file, so a statement is never imported half). `maxRows` bounds the rows read (the preview reads few).
export function parseBankStatement(
  text: string,
  profile: BankStatementProfileShape,
  options: { maxRows?: number; partial?: boolean } = {}
): ParsedBankStatement {
  const maxRows = options.maxRows ?? BankStatementLimits.MAX_ROWS
  const errors: BankRowError[] = []
  let errorCount = 0
  const fail = (
    row: number,
    field: BankStatementField | null,
    code: BankStatementError,
    value: string | null
  ) => {
    errorCount += 1
    if (errors.length < BankStatementLimits.MAX_ERRORS_REPORTED) {
      errors.push({ row, field, code, value })
    }
  }
  const empty: ParsedBankStatement = {
    headers: [],
    lines: [],
    errors,
    errorCount: 0,
    rowCount: 0,
    dateFormatUndecided: false
  }
  const {
    rows,
    lines: startLines,
    unclosedQuote,
    openLine,
    strayRows,
    truncated
  } = splitDelimited(text, profile.delimiter, BankStatementLimits.MAX_ROWS * 2 + 10)
  if (truncated) {
    fail(openLine, null, BankStatementErrors.TOO_MANY_ROWS, null)
    return { ...empty, errorCount }
  }
  if (unclosedQuote && !options.partial) {
    fail(openLine, null, BankStatementErrors.UNCLOSED_QUOTE, null)
    return { ...empty, errorCount }
  }
  // The blank rows are not records: they are never counted by the rows a profile skips. What is skipped is not read at all (it is report
  // text, not a statement), so a stray quote or a wide row in it is of no consequence.
  const records = rows
    .map((cells, index) => ({ cells, line: startLines[index] ?? index + 1, index }))
    .filter(entry => entry.cells.some(cell => cell.trim() !== ''))
  const body = records.slice(profile.skipRows)
  if (body.length === 0 && records.length > 0) {
    fail(1, null, BankStatementErrors.SKIP_PAST_END, String(records.length))
    return { ...empty, errorCount }
  }
  const first = body[0]
  if (profile.hasHeader && first !== undefined && strayRows.has(first.index)) {
    fail(first.line, null, BankStatementErrors.STRAY_QUOTE, null)
    return { ...empty, errorCount }
  }
  if (body.length === 0) {
    fail(1, null, BankStatementErrors.EMPTY_FILE, null)
    return { ...empty, errorCount }
  }
  const headerRow = profile.hasHeader ? (body[0]?.cells ?? []) : []
  const headerLine = body[0]?.line ?? 1
  const data = profile.hasHeader ? body.slice(1) : body
  if (profile.hasHeader && data.length === 0) {
    fail(headerLine, null, BankStatementErrors.EMPTY_FILE, null)
  }
  if (data.length > BankStatementLimits.MAX_ROWS) {
    fail(
      data[BankStatementLimits.MAX_ROWS]?.line ?? 1,
      null,
      BankStatementErrors.TOO_MANY_ROWS,
      String(data.length)
    )
    return { ...empty, headers: headerRow, errorCount }
  }
  const width = profile.hasHeader
    ? headerRow.length
    : widthOfMostRows(data.map(entry => entry.cells.length))
  const reach = profile.hasHeader
    ? width
    : data.reduce((most, entry) => Math.max(most, entry.cells.length), 0)
  const columns: Partial<Record<BankStatementField, number>> = {}
  const mapping: [BankStatementField, BankColumnRef | undefined][] = [
    [BankStatementFields.DATE, profile.columns.date],
    [BankStatementFields.DESCRIPTION, profile.columns.description],
    [BankStatementFields.REFERENCE, profile.columns.reference],
    [BankStatementFields.AMOUNT, profile.columns.amount],
    [BankStatementFields.DEBIT, profile.columns.debit],
    [BankStatementFields.CREDIT, profile.columns.credit]
  ]
  for (const [field, ref] of mapping) {
    const index = resolveColumn(ref, headerRow, profile.hasHeader, reach)
    if (index === null || index === 'ambiguous') {
      fail(
        headerLine,
        field,
        index === null
          ? BankStatementErrors.COLUMN_NOT_FOUND
          : BankStatementErrors.COLUMN_AMBIGUOUS,
        ref === undefined ? null : shown(String(ref))
      )
    } else if (index !== undefined) {
      if (Object.values(columns).includes(index)) {
        fail(headerLine, field, BankStatementErrors.COLUMN_REUSED, shown(String(ref)))
      } else columns[field] = index
    }
  }
  // A file with no header, read by a profile that says it has one and maps by position, would take its first movement for the header
  // and drop it: a first row whose date reads is a movement, never a header
  const dateColumn = columns.date
  if (profile.hasHeader && dateColumn !== undefined) {
    const headerDate = headerRow[dateColumn]
    // Under any of the formats a bank may use, not only the profile's: a file whose dates the profile cannot read is refused for its
    // dates, but its first row must never be taken for a header because of it
    if (
      headerDate !== undefined &&
      Object.values(RemittanceDateFormats).some(
        format => parseImportMoment(headerDate, format) !== null
      )
    ) {
      fail(
        headerLine,
        BankStatementFields.DATE,
        BankStatementErrors.HEADER_LOOKS_LIKE_DATA,
        shown(headerDate)
      )
      return { ...empty, headers: headerRow, errorCount }
    }
  }
  const lines: ParsedBankLine[] = []
  let rowCount = 0
  let sawAmbiguousDay = false
  let sawDecisiveDay = false
  const split = profile.columns.amount === undefined
  const moneyMissing = split
    ? columns.debit === undefined || columns.credit === undefined
    : columns.amount === undefined
  if (errorCount > 0 && (columns.date === undefined || moneyMissing)) {
    return { headers: headerRow, lines, errors, errorCount, rowCount, dateFormatUndecided: false }
  }
  const seen = new Map<string, number>()
  for (const { cells, line: row, index: at } of data.slice(0, maxRows)) {
    rowCount += 1
    const before = errorCount
    if (strayRows.has(at)) {
      fail(row, null, BankStatementErrors.STRAY_QUOTE, null)
      continue
    }
    // A comma that is both the delimiter and the thousands separator: an unquoted 1,234.50 splits into two cells and would shift every
    // cell after it, and an empty cell at the end could hide the shift. Every row must then have exactly the cells of the file.
    const strictWidth =
      profile.thousandsSeparator === BankThousandsSeparators.COMMA &&
      profile.delimiter === RemittanceDelimiters.COMMA
    if (
      cells.slice(width).some(extra => extra.trim() !== '') ||
      (strictWidth && cells.length !== width)
    ) {
      fail(row, null, BankStatementErrors.ROW_TOO_WIDE, String(cells.length))
      continue
    }
    // Without a header the width is the one most rows have, so a file whose every row has an unquoted 1,234.50 has the wrong width as its
    // own and would pass the check above. The mark of the split: an amount cell of one to three digits followed by a cell of exactly
    // three digits (and decimals). A bank prints its amounts with two decimals, so a real amount is never that.
    if (strictWidth) {
      const moneyColumns = [columns.amount, columns.debit, columns.credit]
      const split = moneyColumns.find(index => {
        if (index === undefined) return false
        return (
          /^\d{1,3}$/.test((cells[index] ?? '').trim()) &&
          /^\d{3}(?:\.\d{1,2})?$/.test((cells[index + 1] ?? '').trim())
        )
      })
      if (split !== undefined) {
        const field = (Object.keys(columns) as BankStatementField[]).find(
          key => columns[key] === split
        )
        fail(row, field ?? null, BankStatementErrors.INVALID_AMOUNT, shown(cells[split] ?? ''))
        continue
      }
    }
    const cell = (field: BankStatementField): string | undefined => {
      const index = columns[field]
      return index === undefined ? undefined : cells[index]
    }
    const required = (field: BankStatementField): string | null => {
      const value = cell(field)
      if (value === undefined) {
        fail(row, field, BankStatementErrors.MISSING_CELL, null)
        return null
      }
      if (value.trim() === '') {
        fail(row, field, BankStatementErrors.EMPTY_VALUE, null)
        return null
      }
      return value
    }
    let postedOn: string | null = null
    let postedTime: string | null = null
    const dateCell = required(BankStatementFields.DATE)
    if (dateCell !== null) {
      const moment = parseImportMoment(dateCell, profile.dateFormat)
      postedOn = moment?.day ?? null
      postedTime = moment?.time ?? null
      if (moment === null) {
        fail(row, BankStatementFields.DATE, BankStatementErrors.INVALID_DATE, shown(dateCell))
      } else {
        const evidence = dayOrderEvidence(splitMoment(dateCell).dayText, profile.dateFormat)
        if (evidence === 'ambiguous') sawAmbiguousDay = true
        if (evidence === 'decisive') sawDecisiveDay = true
      }
    }
    let amount: number | null = null
    if (!split) {
      const amountCell = required(BankStatementFields.AMOUNT)
      if (amountCell !== null) {
        amount = parseBankAmountCents(
          amountCell,
          profile.decimalSeparator,
          profile.thousandsSeparator,
          true
        )
        if (amount === null) {
          fail(
            row,
            BankStatementFields.AMOUNT,
            BankStatementErrors.INVALID_AMOUNT,
            shown(amountCell)
          )
        }
      }
    } else {
      // A bank that prints a 0.00 in the column that does not apply is read as saying nothing there: exactly one of the two says an
      // amount, the other is empty or zero; both saying one, or neither saying anything, does not say which way the money went
      const sides = (
        [
          [BankStatementFields.DEBIT, cell(BankStatementFields.DEBIT), -1],
          [BankStatementFields.CREDIT, cell(BankStatementFields.CREDIT), 1]
        ] as const
      ).map(([field, value, sign]) => {
        // A bank that prints a dash in the column that does not apply says nothing there, like an empty cell (HC-125)
        const text = value?.trim() ?? ''
        if (value === undefined || text === '' || NOTHING_MARKS.has(text))
          return { field, filled: false, cents: 0, sign }
        const cents = parseBankAmountCents(
          value,
          profile.decimalSeparator,
          profile.thousandsSeparator,
          false
        )
        if (cents === null) {
          fail(row, field, BankStatementErrors.INVALID_AMOUNT, shown(value))
          return { field, filled: true, cents: null, sign }
        }
        return { field, filled: true, cents, sign }
      })
      if (sides.every(side => side.cents !== null)) {
        const spoken = sides.filter(side => side.cents !== 0)
        const only = spoken[0]
        if (spoken.length === 1 && only !== undefined && only.cents !== null) {
          amount = only.sign * only.cents
        } else if (spoken.length === 0 && sides.some(side => side.filled)) {
          amount = 0
        } else {
          fail(row, null, BankStatementErrors.AMBIGUOUS_DIRECTION, null)
        }
      }
    }
    if (amount === 0) {
      fail(row, split ? null : BankStatementFields.AMOUNT, BankStatementErrors.ZERO_AMOUNT, null)
    }
    let description: string | null = null
    const descriptionCell = cell(BankStatementFields.DESCRIPTION)
    if (descriptionCell !== undefined && descriptionCell.trim() !== '') {
      // The description is information, not what the money is: a long memo (banks join the text of a transfer) is cut, and one that
      // spans lines (banks do that too) is read as one line, never a reason to refuse the statement
      description = cleanText(
        Array.from(descriptionCell.replace(LINE_BREAKS, ' ').trim())
          .slice(0, BankStatementLimits.DESCRIPTION_MAX_LENGTH)
          .join(''),
        BankStatementLimits.DESCRIPTION_MAX_LENGTH
      )
      if (description === null) {
        fail(
          row,
          BankStatementFields.DESCRIPTION,
          BankStatementErrors.INVALID_TEXT,
          shown(descriptionCell)
        )
      }
    }
    let reference: string | null = null
    const referenceCell = cell(BankStatementFields.REFERENCE)
    if (referenceCell !== undefined && referenceCell.trim() !== '') {
      reference = cleanText(referenceCell, BankStatementLimits.REFERENCE_MAX_LENGTH)
      if (reference === null) {
        fail(
          row,
          BankStatementFields.REFERENCE,
          BankStatementErrors.INVALID_TEXT,
          shown(referenceCell)
        )
      }
    }
    if (errorCount === before && postedOn !== null && amount !== null && amount !== 0) {
      // Two lines are the same when day, time, amount, reference and description agree; which of the equal ones this is follows file order
      const key = [postedOn, postedTime ?? '', amount, reference ?? '', description ?? ''].join(
        '\u0000'
      )
      const occurrence = seen.get(key) ?? 0
      seen.set(key, occurrence + 1)
      lines.push({
        postedOn,
        postedTime,
        amountCents: amount,
        description,
        reference,
        row,
        occurrence
      })
    }
  }
  return {
    headers: headerRow,
    lines,
    errors,
    errorCount,
    rowCount,
    dateFormatUndecided: sawAmbiguousDay && !sawDecisiveDay
  }
}

// What makes a line of a statement the same line when it comes again (the service hashes it): the account, the day, the amount, the
// reference and the description, and which of the equal ones it is in its file (two identical lines of a statement are two movements).
// When the date of the row had a time, the time is part of the identity: two equal movements of one day at two times are two lines, and a
// later statement that starts in the middle of that day and brings only the second one brings it with its own time, so it is known and
// is never doubled. A line with no time keeps the identity it always had, so what was imported before is still recognised. A movement
// that one statement prints with a time and another without it is not recognised as the same: a bank prints it one way.
export function bankLineKey(accountId: string, line: ParsedBankLine): string {
  return [
    accountId,
    line.postedOn,
    String(line.amountCents),
    line.reference ?? '',
    line.description ?? '',
    String(line.occurrence),
    ...(line.postedTime === null ? [] : [line.postedTime])
  ].join('\u0000')
}

// ------------------------------------------------------------------------------------------------------ the matching

// A line of the statement, as the matcher sees it
export interface MatchStatementLine {
  id: string
  postedOn: string
  amountCents: number
  reference: string | null
}

// A line of the journal on the cash account being reconciled that no confirmed match has taken yet. `signedCents` is debit minus credit:
// money that came into the account is positive, like the statement. `texts` are what the books say about it (the supplier's document
// number, the memo), compared with the statement's reference.
export interface MatchBookLine {
  id: string
  entryDate: string
  signedCents: number
  texts: readonly string[]
}

export interface MatchSuggestion {
  bookLineId: string
  // Whole days between the statement's date and the books' date
  dayDifference: number
  referenceMatch: boolean
  // The same day or the reference is in the books: the strongest the deterministic rules say
  exact: boolean
}

export function daysBetween(a: string, b: string): number {
  return Math.abs(
    Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS)
  )
}

function normalizeText(value: string): string {
  return plainText(value)
}

// Does the reference of the bank appear in what the books say, or the other way round? Only a token that can be a document number:
// the shorter text has at least 4 characters and a digit ("Pago" or "Venta" is in every memo and says nothing), so a generic word
// never makes a match "exact".
export function referencesAgree(reference: string | null, texts: readonly string[]): boolean {
  if (reference === null) return false
  const wanted = normalizeText(reference)
  return texts.some(text => {
    const other = normalizeText(text)
    const [shorter, longer] = wanted.length <= other.length ? [wanted, other] : [other, wanted]
    if (shorter.length < BankStatementLimits.REFERENCE_MIN_MATCH_LENGTH || !/\d/.test(shorter)) {
      return false
    }
    // As a whole token: "0012" is not inside "INV-100125"
    return new RegExp(`(?:^|[^a-z0-9])${escapeForPattern(shorter)}(?:[^a-z0-9]|$)`).test(longer)
  })
}

// The lines of the books a statement line may be matched with: the amount equal to the cent, in the same direction, within the window
// of days. Rejected pairs ("lineId:bookLineId") are never suggested again. Strongest first: the reference, then the nearest day, then
// the id (so the order never changes between two reads).
export function suggestMatches(
  lines: readonly MatchStatementLine[],
  book: readonly MatchBookLine[],
  windowDays: number,
  rejected: ReadonlySet<string>
): Map<string, MatchSuggestion[]> {
  const byAmount = new Map<number, MatchBookLine[]>()
  for (const candidate of book) {
    const list = byAmount.get(candidate.signedCents)
    if (list === undefined) byAmount.set(candidate.signedCents, [candidate])
    else list.push(candidate)
  }
  const result = new Map<string, MatchSuggestion[]>()
  for (const line of lines) {
    const found: MatchSuggestion[] = []
    for (const candidate of byAmount.get(line.amountCents) ?? []) {
      if (rejected.has(`${line.id}:${candidate.id}`)) continue
      const dayDifference = daysBetween(line.postedOn, candidate.entryDate)
      if (dayDifference > windowDays) continue
      const referenceMatch = referencesAgree(line.reference, candidate.texts)
      found.push({
        bookLineId: candidate.id,
        dayDifference,
        referenceMatch,
        exact: dayDifference === 0 || referenceMatch
      })
    }
    found.sort(
      (a, b) =>
        Number(b.referenceMatch) - Number(a.referenceMatch) ||
        a.dayDifference - b.dayDifference ||
        a.bookLineId.localeCompare(b.bookLineId)
    )
    result.set(line.id, found)
  }
  return result
}

// The pairs that are safe to confirm all at once: the line has ONE suggestion, it is exact, and no other line has that same book line
// as a suggestion. Anything with a second possibility is left for a person to choose.
export function unambiguousExactPairs(
  suggestions: ReadonlyMap<string, readonly MatchSuggestion[]>
): { lineId: string; bookLineId: string }[] {
  const claims = new Map<string, number>()
  for (const list of suggestions.values()) {
    for (const suggestion of list) {
      claims.set(suggestion.bookLineId, (claims.get(suggestion.bookLineId) ?? 0) + 1)
    }
  }
  const pairs: { lineId: string; bookLineId: string }[] = []
  for (const [lineId, list] of suggestions) {
    const only = list.length === 1 ? list[0] : undefined
    if (only !== undefined && only.exact && claims.get(only.bookLineId) === 1) {
      pairs.push({ lineId, bookLineId: only.bookLineId })
    }
  }
  return pairs.sort((a, b) => a.lineId.localeCompare(b.lineId))
}

// Whether a statement line and a line of the books can be a pair at all (the check a person's confirmation must pass, whatever the
// screen sent): the same amount in the same direction, within the window
export function canPair(
  line: Pick<MatchStatementLine, 'postedOn' | 'amountCents'>,
  book: Pick<MatchBookLine, 'entryDate' | 'signedCents'>,
  windowDays: number
): boolean {
  return (
    line.amountCents === book.signedCents &&
    daysBetween(line.postedOn, book.entryDate) <= windowDays
  )
}
