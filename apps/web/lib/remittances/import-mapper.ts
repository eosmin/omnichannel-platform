import type { ImportRowErrorView, RemittanceImportProfileView } from '@platform/api-client'
import {
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  RemittanceImportFiles,
  RemittanceImportLimits,
  type RemittanceImportProfileBody,
  remittanceProfileProblem
} from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

// The pure part of the import mapper (TDD_17 §4.15): how a settlement file is decoded and sampled, how the form becomes the
// mapping the api reads the file with, and how the answers of the api are read back. Nothing here guesses a locale or an
// amount: the parsing of the file is the api's, and this only prepares what is sent and shows what comes back.

export const ImportEncodings = { UTF8: 'utf-8', WINDOWS_1252: 'windows-1252' } as const
export type ImportEncoding = (typeof ImportEncodings)[keyof typeof ImportEncodings]

export type DecodedFile =
  | { ok: true; text: string; encoding: ImportEncoding }
  | { ok: false; reason: 'too_large' | 'empty' | 'not_text' }

// A file as the person chose it, read in the encoding they say. UTF-8 is refused when the bytes are not UTF-8 (Excel often
// saves a CSV as Windows-1252): the screen then offers the other encoding instead of showing broken letters.
export function decodeFile(buffer: ArrayBuffer, encoding: ImportEncoding): DecodedFile {
  if (buffer.byteLength > RemittanceImportLimits.MAX_BYTES)
    return { ok: false, reason: 'too_large' }
  if (buffer.byteLength === 0) return { ok: false, reason: 'empty' }
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer)
    return text.includes('\u0000')
      ? { ok: false, reason: 'not_text' }
      : { ok: true, text, encoding }
  } catch {
    return { ok: false, reason: 'not_text' }
  }
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// The first rows of the text, whole lines only, as many as fit in what a preview takes (the sample travels as JSON and the
// api refuses a larger one). A first line that alone is too large leaves nothing: the person is told to use a smaller file.
export function sampleOf(text: string): string {
  if (byteLength(text) <= RemittanceImportLimits.PREVIEW_MAX_BYTES) return text
  const lines = text.split(/\r\n|\n|\r/)
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    const next = size + byteLength(line) + 1
    if (next > RemittanceImportLimits.PREVIEW_MAX_BYTES) break
    kept.push(line)
    size = next
  }
  return kept.join('\n')
}

// A starting delimiter for the mapper: the one that appears most in the first line. It is a suggestion the person changes, and
// nothing is parsed with it until they accept the preview.
export function guessDelimiter(text: string): RemittanceImportProfileBody['delimiter'] {
  const first = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  const count = (char: string): number => first.split(char).length - 1
  const options = [
    RemittanceDelimiters.TAB,
    RemittanceDelimiters.SEMICOLON,
    RemittanceDelimiters.COMMA
  ] as const
  let best: (typeof options)[number] = RemittanceDelimiters.COMMA
  let bestCount = 0
  for (const option of options) {
    if (count(option) > bestCount) {
      best = option
      bestCount = count(option)
    }
  }
  return best
}

// The texts of the first line of the file, as suggestions for the column fields (a header with quotes loses them). It only helps
// the person type: the api reads the real header and names a column it cannot find.
export function headerSuggestions(
  text: string,
  delimiter: RemittanceImportProfileBody['delimiter']
): string[] {
  const first = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  const cells = first
    .replace(/^\uFEFF/, '')
    .split(delimiter)
    .map(cell =>
      cell
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim()
    )
    .filter(cell => cell !== '')
  return Array.from(new Set(cells)).slice(0, 60)
}

// A TSV is sent as one, anything else as CSV: the api keeps the extension of the copy it stores from this
export function contentTypeOf(delimiter: RemittanceImportProfileBody['delimiter']): string {
  return delimiter === RemittanceDelimiters.TAB
    ? RemittanceImportFiles.TSV.contentType
    : RemittanceImportFiles.CSV.contentType
}

// ------------------------------------------------------------------------------------------------------ the form

export interface MapperForm {
  delimiter: RemittanceImportProfileBody['delimiter']
  hasHeader: boolean
  decimalSeparator: RemittanceImportProfileBody['decimalSeparator']
  dateFormat: RemittanceImportProfileBody['dateFormat']
  // What the person typed for each value: the text of a header, or a position when the file has none
  guideNumber: string
  amount: string
  fee: string
  date: string
  reference: string
}

export const EMPTY_FORM: MapperForm = {
  delimiter: RemittanceDelimiters.COMMA,
  hasHeader: true,
  decimalSeparator: RemittanceDecimalSeparators.DOT,
  dateFormat: RemittanceDateFormats.ISO,
  guideNumber: '',
  amount: '',
  fee: '',
  date: '',
  reference: ''
}

export const COLUMN_FIELDS = ['guideNumber', 'amount', 'fee', 'date', 'reference'] as const
export type ColumnField = (typeof COLUMN_FIELDS)[number]
const REQUIRED_FIELDS: readonly ColumnField[] = ['guideNumber', 'amount']
const MAX_POSITION = 200

export type MappingProblem =
  | { kind: 'required'; field: ColumnField }
  | { kind: 'position'; field: ColumnField }
  | { kind: 'rule' }

export type MappingResult =
  { ok: true; profile: RemittanceImportProfileBody } | { ok: false; problem: MappingProblem }

// What the form says as the mapping of the api: by header text when the file has a header, by position (0 is the first column)
// when it has none. The two rules the api repeats (each value from its own column, the delimiter is not the decimal comma) are
// the domain's own function, so the screen and the api cannot disagree.
export function mappingOf(form: MapperForm): MappingResult {
  const columns: Record<string, string | number> = {}
  for (const field of COLUMN_FIELDS) {
    const text = form[field].trim()
    if (text === '') {
      if (REQUIRED_FIELDS.includes(field))
        return { ok: false, problem: { kind: 'required', field } }
      continue
    }
    if (form.hasHeader) {
      columns[field] = text
    } else {
      if (!/^\d{1,3}$/.test(text) || Number(text) > MAX_POSITION) {
        return { ok: false, problem: { kind: 'position', field } }
      }
      columns[field] = Number(text)
    }
  }
  const profile = {
    delimiter: form.delimiter,
    hasHeader: form.hasHeader,
    decimalSeparator: form.decimalSeparator,
    dateFormat: form.dateFormat,
    columns: columns as unknown as RemittanceImportProfileBody['columns']
  }
  if (remittanceProfileProblem({ ...profile, columns }) !== null) {
    return { ok: false, problem: { kind: 'rule' } }
  }
  return { ok: true, profile }
}

// A saved profile back into the form (a position is shown as its number)
export function formOf(profile: RemittanceImportProfileView): MapperForm {
  const text = (value: string | number | undefined): string =>
    value === undefined ? '' : String(value)
  return {
    delimiter: profile.delimiter,
    hasHeader: profile.hasHeader,
    decimalSeparator: profile.decimalSeparator,
    dateFormat: profile.dateFormat,
    guideNumber: text(profile.columns.guideNumber),
    amount: text(profile.columns.amount),
    fee: text(profile.columns.fee),
    date: text(profile.columns.date),
    reference: text(profile.columns.reference)
  }
}

// True when the form is exactly what the profile saved: only then is "Import" offered, because the api reads the file with the
// saved profile and never with an unsaved mapping
export function sameAsProfile(form: MapperForm, profile: RemittanceImportProfileView): boolean {
  const saved = formOf(profile)
  return (
    saved.delimiter === form.delimiter &&
    saved.hasHeader === form.hasHeader &&
    saved.decimalSeparator === form.decimalSeparator &&
    saved.dateFormat === form.dateFormat &&
    COLUMN_FIELDS.every(field => saved[field] === form[field].trim())
  )
}

// ------------------------------------------------------------------------------------------------------ the answers

// The row errors a refused import carries (`metadata.errors`, bounded by the api). Anything that is not a list of errors with a
// row and a code is left out, so a changed shape shows fewer rows and never breaks the page.
export function importErrorsOf(error: unknown): {
  errors: ImportRowErrorView[]
  count: number
} | null {
  const candidate = error as
    { code?: unknown; metadata?: { errors?: unknown; errorCount?: unknown } } | null | undefined
  if (candidate?.code !== ClientErrorCodes.REMITTANCE_IMPORT_INVALID) return null
  const raw = candidate.metadata?.errors
  const errors = (Array.isArray(raw) ? raw : []).flatMap((entry: unknown): ImportRowErrorView[] => {
    const row = entry as Partial<ImportRowErrorView> | null
    if (typeof row?.row !== 'number' || typeof row.code !== 'string') return []
    return [
      {
        row: row.row,
        field: row.field ?? null,
        code: row.code,
        value: typeof row.value === 'string' ? row.value : null
      }
    ]
  })
  const count = candidate.metadata?.errorCount
  return { errors, count: typeof count === 'number' ? count : errors.length }
}
