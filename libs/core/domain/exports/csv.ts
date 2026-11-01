import { CSV_BOM } from './export-constants'

export type CsvValue = string | number | boolean | Date | null | undefined

// A text that starts with one of these is a formula to a spreadsheet. Names and messages come from
// third parties, so the cell is prefixed with a single quote and the program shows it as text.
const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/

// One cell of a CSV (RFC 4180). A number is written as it is, even a negative one: only text can be
// read as a formula.
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = value instanceof Date ? value.toISOString() : value
  const safe = FORMULA_START.test(text) ? `'${text}` : text
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

// A line with its terminator
export function csvLine(values: readonly CsvValue[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

// The first chunk of a file: the mark for the spreadsheet and the header
export function csvHeader(columns: readonly string[]): string {
  return CSV_BOM + csvLine(columns)
}
