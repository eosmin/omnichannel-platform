import { CSV_BOM } from './export-constants'

// A number with a fixed count of decimals (money: 50 cents is 0.50), written as the number it is and never as a text: a negative one
// must not take the quote of a formula. Only a plain decimal can be built, so nothing a person wrote can pass as one.
export class CsvDecimal {
  readonly text: string

  constructor(value: number, decimals: number) {
    if (!Number.isFinite(value)) throw new RangeError('a CSV decimal must be a finite number')
    this.text = value.toFixed(decimals)
  }
}

export type CsvValue = string | number | boolean | Date | CsvDecimal | null | undefined

// A text that starts with one of these is a formula to a spreadsheet. Names and messages come from
// third parties, so the cell is prefixed with a single quote and the program shows it as text.
// The defused text is written back to the original by dropping ONE leading quote, so a text that already is `'=1+1` must also take
// a quote (it comes out as `''=1+1`): two different texts never share a cell, and the cell reads back as exactly what was written
// (LED-R2-010, the auditor recomputes the hash of a memo from its CSV cell).
const NEEDS_DEFUSING = /^'*[=+\-@\t\r]/
const DEFUSED = /^'+[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/

// One cell of a CSV (RFC 4180). A number is written as it is, even a negative one: only text can be
// read as a formula.
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof CsvDecimal) return value.text
  const text = value instanceof Date ? value.toISOString() : value
  const safe = NEEDS_DEFUSING.test(text) ? `'${text}` : text
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

// The text a cell of `csvCell` stands for, once the CSV quoting is undone: the inverse of the defusing. A cell that starts with quotes
// and then a formula character had one quote added when it was written.
export function csvCellText(cell: string): string {
  return DEFUSED.test(cell) ? cell.slice(1) : cell
}

// A line with its terminator
export function csvLine(values: readonly CsvValue[]): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

// The first chunk of a file: the mark for the spreadsheet and the header
export function csvHeader(columns: readonly string[]): string {
  return CSV_BOM + csvLine(columns)
}
