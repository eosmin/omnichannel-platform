import { AgingBucketDays } from '@platform/core/domain'
import { csvHeader, csvLine } from '@platform/core/exports'

// The CSV of the statements (TDD_18 §10): amounts are whole cents written as numbers, every text goes through the writer of the other
// exports (a text that starts like a formula is written as text).

export const STATEMENT_CSV_COLUMNS = [
  'section',
  'code',
  'name',
  'amount_cents',
  'rollup_cents'
] as const

export interface StatementCsvRow {
  section: string
  code: string | null
  name: string
  amountCents: number
  rollupCents: number | null
}

export const statementCsv = (rows: readonly StatementCsvRow[]): string =>
  csvHeader(STATEMENT_CSV_COLUMNS) +
  rows
    .map(row => csvLine([row.section, row.code, row.name, row.amountCents, row.rollupCents]))
    .join('')

// 0-30, 31-60, 61-90, 91+ for the cuts of AgingBucketDays
export const agingBucketColumns = (): string[] => {
  const cuts = AgingBucketDays
  return [
    ...cuts.map((cut, index) => `days_${String((cuts[index - 1] ?? -1) + 1)}_${String(cut)}`),
    `days_${String((cuts.at(-1) ?? 0) + 1)}_plus`
  ]
}

export interface AgingCsvRow {
  partyType: string | null
  partyId: string | null
  partyName: string | null
  bucketsCents: number[]
  unappliedCents: number
  totalCents: number
}

export const agingCsv = (kind: string, asOf: string, rows: readonly AgingCsvRow[]): string =>
  csvHeader([
    'kind',
    'as_of',
    'party_type',
    'party_id',
    'party_name',
    ...agingBucketColumns(),
    'unapplied_cents',
    'total_cents'
  ]) +
  rows
    .map(row =>
      csvLine([
        kind,
        asOf,
        row.partyType,
        row.partyId,
        row.partyName,
        ...row.bucketsCents,
        row.unappliedCents,
        row.totalCents
      ])
    )
    .join('')
