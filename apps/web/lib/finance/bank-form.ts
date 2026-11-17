import type {
  BankMappingView,
  BankPreviewReading,
  BankProfileView,
  CreateBankProfileInput,
  UpdateBankProfileInput
} from '@platform/api-client'
import {
  bankProfileProblem,
  BankStatementEncodings,
  BankStatementLimits,
  BankThousandsSeparators,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  type RemittanceDelimiter,
  splitDelimited
} from '@platform/core/domain'

// The form of a bank profile (TDD_18 §4.4): how the CSV of one bank is read. The rules a profile keeps are the domain's own function
// (`bankProfileProblem`, the one the api refuses with), so the screen and the api cannot disagree; the parsing of the file is the api's.

export const DELIMITERS = Object.values(RemittanceDelimiters)
export const DECIMAL_SEPARATORS = Object.values(RemittanceDecimalSeparators)
export const THOUSANDS_SEPARATORS = Object.values(BankThousandsSeparators)
export const DATE_FORMATS = Object.values(RemittanceDateFormats)
export const ENCODINGS = Object.values(BankStatementEncodings)

// How the money is read: one signed column, or one column for what went out and one for what came in
export const MoneyModes = { SIGNED: 'signed', SPLIT: 'split' } as const
export type MoneyMode = (typeof MoneyModes)[keyof typeof MoneyModes]

export interface BankProfileDraft {
  name: string
  delimiter: string
  hasHeader: boolean
  // Records to leave out at the start of the file, as typed
  skipRows: string
  decimalSeparator: string
  thousandsSeparator: string
  dateFormat: string
  encoding: string
  // Days, as typed
  dateWindowDays: string
  mode: MoneyMode
  // What the person typed for each value: the text of a header, or a position when the file has none
  date: string
  description: string
  reference: string
  amount: string
  debit: string
  credit: string
}

export const emptyBankDraft = (): BankProfileDraft => ({
  name: '',
  delimiter: RemittanceDelimiters.COMMA,
  hasHeader: true,
  skipRows: '0',
  decimalSeparator: RemittanceDecimalSeparators.DOT,
  thousandsSeparator: BankThousandsSeparators.NONE,
  dateFormat: RemittanceDateFormats.ISO,
  encoding: BankStatementEncodings.UTF8,
  dateWindowDays: String(BankStatementLimits.DATE_WINDOW_DEFAULT_DAYS),
  mode: MoneyModes.SIGNED,
  date: '',
  description: '',
  reference: '',
  amount: '',
  debit: '',
  credit: ''
})

const text = (value: string | number | undefined): string =>
  value === undefined ? '' : String(value)

export function bankDraftOf(profile: BankProfileView): BankProfileDraft {
  const split = profile.columns.debit !== undefined || profile.columns.credit !== undefined
  return {
    name: profile.name,
    delimiter: profile.delimiter,
    hasHeader: profile.hasHeader,
    skipRows: String(profile.skipRows),
    decimalSeparator: profile.decimalSeparator,
    thousandsSeparator: profile.thousandsSeparator,
    dateFormat: profile.dateFormat,
    encoding: profile.encoding,
    dateWindowDays: String(profile.dateWindowDays),
    mode: split ? MoneyModes.SPLIT : MoneyModes.SIGNED,
    date: text(profile.columns.date),
    description: text(profile.columns.description),
    reference: text(profile.columns.reference),
    amount: text(profile.columns.amount),
    debit: text(profile.columns.debit),
    credit: text(profile.columns.credit)
  }
}

export const BankProfileFields = {
  NAME: 'name',
  DATE: 'date',
  DESCRIPTION: 'description',
  REFERENCE: 'reference',
  AMOUNT: 'amount',
  DEBIT: 'debit',
  CREDIT: 'credit',
  WINDOW: 'dateWindowDays',
  SKIP_ROWS: 'skipRows',
  // The profile as a whole breaks a rule of the profiles (two values from one column, the delimiter is the decimal separator, ...)
  RULE: 'rule'
} as const
export type BankProfileField = (typeof BankProfileFields)[keyof typeof BankProfileFields]

export type BankProfileResult<T> = { ok: true; value: T } | { ok: false; field: BankProfileField }

const MAX_POSITION = BankStatementLimits.COLUMN_POSITION_MAX
const HEADER_MAX_LENGTH = BankStatementLimits.COLUMN_HEADER_MAX_LENGTH

type ColumnField = 'date' | 'description' | 'reference' | 'amount' | 'debit' | 'credit'

// A column the way the api takes it: the text of a header when the file has one, its position (0 is the first column) when it has
// none. null is a value that cannot be a column.
function columnOf(raw: string, hasHeader: boolean): string | number | null {
  const value = raw.trim()
  if (hasHeader) {
    // eslint-disable-next-line no-control-regex -- a header is one visible line
    return value.length >= 1 && value.length <= HEADER_MAX_LENGTH && !/[\r\n\u0000]/.test(value)
      ? value
      : null
  }
  return /^\d{1,3}$/.test(value) && Number(value) <= MAX_POSITION ? Number(value) : null
}

// What the form says as the mapping of the api, or the first column that is wrong
function mappingOf(draft: BankProfileDraft): BankProfileResult<BankMappingView> {
  const wanted: { field: ColumnField; required: boolean }[] = [
    { field: 'date', required: true },
    { field: 'description', required: false },
    { field: 'reference', required: false },
    ...(draft.mode === MoneyModes.SIGNED
      ? [{ field: 'amount' as const, required: true }]
      : [
          { field: 'debit' as const, required: true },
          { field: 'credit' as const, required: true }
        ])
  ]
  const optional: Partial<Record<ColumnField, string | number>> = {}
  let date: string | number | null = null
  for (const { field, required } of wanted) {
    if (draft[field].trim() === '') {
      if (required) return { ok: false, field }
      continue
    }
    const column = columnOf(draft[field], draft.hasHeader)
    if (column === null) return { ok: false, field }
    if (field === 'date') date = column
    else optional[field] = column
  }
  // The date is required: it is what the loop returns for when it is missing, so it is here
  if (date === null) return { ok: false, field: 'date' }
  return { ok: true, value: { ...optional, date } }
}

function windowOf(draft: BankProfileDraft): number | null {
  const value = draft.dateWindowDays.trim()
  if (!/^\d{1,2}$/.test(value)) return null
  const days = Number(value)
  return days <= BankStatementLimits.DATE_WINDOW_MAX_DAYS ? days : null
}

function skipRowsOf(draft: BankProfileDraft): number | null {
  const value = draft.skipRows.trim()
  if (!/^\d{1,2}$/.test(value)) return null
  const rows = Number(value)
  return rows <= BankStatementLimits.SKIP_ROWS_MAX ? rows : null
}

// How the file is read, checked: the preview of the mapper and a saved profile both take this
export function bankReadingOf(
  draft: BankProfileDraft
): BankProfileResult<Required<BankPreviewReading>> {
  const columns = mappingOf(draft)
  if (!columns.ok) return columns
  const dateWindowDays = windowOf(draft)
  if (dateWindowDays === null) return { ok: false, field: BankProfileFields.WINDOW }
  const skipRows = skipRowsOf(draft)
  if (skipRows === null) return { ok: false, field: BankProfileFields.SKIP_ROWS }
  const reading = {
    delimiter: draft.delimiter,
    hasHeader: draft.hasHeader,
    skipRows,
    decimalSeparator: draft.decimalSeparator,
    thousandsSeparator: draft.thousandsSeparator,
    dateFormat: draft.dateFormat,
    encoding: draft.encoding,
    dateWindowDays,
    columns: columns.value
  }
  if (
    bankProfileProblem({
      hasHeader: reading.hasHeader,
      delimiter: reading.delimiter,
      decimalSeparator: reading.decimalSeparator,
      thousandsSeparator: reading.thousandsSeparator,
      columns: { ...columns.value }
    }) !== null
  ) {
    return { ok: false, field: BankProfileFields.RULE }
  }
  return { ok: true, value: reading }
}

function nameOf(draft: BankProfileDraft): string | null {
  const name = draft.name.trim()
  return name.length >= 1 &&
    name.length <= BankStatementLimits.PROFILE_NAME_MAX_LENGTH &&
    // eslint-disable-next-line no-control-regex -- a name is one visible line
    !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name)
    ? name
    : null
}

// A new profile, for the account the screen is on
export function createBankProfileInputOf(
  draft: BankProfileDraft,
  accountId: string
): BankProfileResult<CreateBankProfileInput> {
  const name = nameOf(draft)
  if (name === null) return { ok: false, field: BankProfileFields.NAME }
  const reading = bankReadingOf(draft)
  if (!reading.ok) return reading
  return { ok: true, value: { accountId, name, ...reading.value } }
}

// A change sends the whole reading (a half of it could break a rule the api keeps on the whole)
export function updateBankProfileInputOf(
  draft: BankProfileDraft
): BankProfileResult<UpdateBankProfileInput> {
  const name = nameOf(draft)
  if (name === null) return { ok: false, field: BankProfileFields.NAME }
  const reading = bankReadingOf(draft)
  if (!reading.ok) return reading
  return { ok: true, value: { name, ...reading.value } }
}

// The words of a delimiter and of a decimal separator are keyed by name, not by the character
export const delimiterKey = (value: string): 'tab' | 'comma' | 'semicolon' =>
  value === RemittanceDelimiters.TAB
    ? 'tab'
    : value === RemittanceDelimiters.SEMICOLON
      ? 'semicolon'
      : 'comma'
export const decimalKey = (value: string): 'dot' | 'comma' =>
  value === RemittanceDecimalSeparators.COMMA ? 'comma' : 'dot'

export const MONEY_MODE_OPTIONS: readonly MoneyMode[] = [MoneyModes.SIGNED, MoneyModes.SPLIT]

// The row that names the columns of a sample, once the lead the profile skips is left out: the records are the parser's (blank rows do not
// count, a quoted line break is inside one), so the suggestions are the words of that row and not of a report title
function sampleRecords(text: string, delimiter: string, skipRows: number): string[][] {
  const split = splitDelimited(text, delimiter as RemittanceDelimiter)
  return split.rows.filter(cells => cells.some(cell => cell.trim() !== '')).slice(skipRows)
}

export function bankHeaderSuggestions(text: string, delimiter: string, skipRows: number): string[] {
  const first = sampleRecords(text, delimiter, skipRows)[0] ?? []
  const cells = first
    .map(cell => cell.trim())
    .filter(cell => cell !== '')
    .map(cell => cell.replace(/\s+/g, ' '))
  return Array.from(new Set(cells)).slice(0, 60)
}

// The delimiter that cuts the first record after the lead into the most cells: a suggestion the person changes
export function guessBankDelimiter(text: string, skipRows: number): RemittanceDelimiter {
  let best: RemittanceDelimiter = RemittanceDelimiters.COMMA
  let bestCount = 0
  for (const option of [
    RemittanceDelimiters.TAB,
    RemittanceDelimiters.SEMICOLON,
    RemittanceDelimiters.COMMA
  ] as const) {
    const count = (sampleRecords(text, option, skipRows)[0] ?? []).length
    if (count > 1 && count > bestCount) {
      best = option
      bestCount = count
    }
  }
  return best
}

// The rows to skip as the number the form holds (a value that is not one skips none: the form refuses it when it is sent)
export function skipRowsOfDraft(draft: Pick<BankProfileDraft, 'skipRows'>): number {
  const value = Number(draft.skipRows.trim())
  return Number.isInteger(value) && value >= 0 && value <= BankStatementLimits.SKIP_ROWS_MAX
    ? value
    : 0
}
