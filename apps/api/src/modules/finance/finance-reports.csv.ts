import { csvHeader, csvLine } from '@platform/core/exports'

// The CSV files an auditor takes out (TDD_18 §10, §11). Amounts are whole cents written as numbers; every text cell goes through the
// same writer as every other export, so a text that starts like a formula is written as text (with a leading quote, which a
// verification script strips before it recomputes a hash).

export interface JournalCsvRow {
  number: number
  entryId: string
  entryDate: string
  periodId: string
  type: string
  sourceType: string | null
  sourceId: string | null
  sourceDate: string | null
  reversesEntryId: string | null
  idempotencyKey: string
  entryMemo: string | null
  currency: string
  totalCents: number
  origin: string
  createdBy: string | null
  prevHash: string | null
  hash: string
  lineNo: number
  accountId: string
  accountCode: string
  accountName: string
  debitCents: number
  creditCents: number
  storeId: string | null
  partyType: string | null
  partyId: string | null
  taxRateId: string | null
  lineMemo: string | null
}

// One row per line, with every field the hash of the entry covers (`ledger-hash.ts`): the auditor recomputes the chain from this file
export const JOURNAL_CSV_COLUMNS = [
  'number',
  'entry_id',
  'entry_date',
  'period_id',
  'type',
  'source_type',
  'source_id',
  'source_date',
  'reverses_entry_id',
  'idempotency_key',
  'entry_memo',
  'currency',
  'total_cents',
  'origin',
  'created_by',
  'prev_hash',
  'hash',
  'line_no',
  'account_id',
  'account_code',
  'account_name',
  'debit_cents',
  'credit_cents',
  'store_id',
  'party_type',
  'party_id',
  'tax_rate_id',
  'line_memo'
] as const

export const journalCsvHeader = (): string => csvHeader(JOURNAL_CSV_COLUMNS)

export const journalCsvRows = (rows: readonly JournalCsvRow[]): string =>
  rows
    .map(row =>
      csvLine([
        row.number,
        row.entryId,
        row.entryDate,
        row.periodId,
        row.type,
        row.sourceType,
        row.sourceId,
        row.sourceDate,
        row.reversesEntryId,
        row.idempotencyKey,
        row.entryMemo,
        row.currency,
        row.totalCents,
        row.origin,
        row.createdBy,
        row.prevHash,
        row.hash,
        row.lineNo,
        row.accountId,
        row.accountCode,
        row.accountName,
        row.debitCents,
        row.creditCents,
        row.storeId,
        row.partyType,
        row.partyId,
        row.taxRateId,
        row.lineMemo
      ])
    )
    .join('')

export interface LedgerCsvRow {
  number: number
  entryDate: string
  lineNo: number
  type: string
  sourceType: string | null
  sourceId: string | null
  entryMemo: string | null
  lineMemo: string | null
  storeId: string | null
  partyType: string | null
  partyId: string | null
  debitCents: number
  creditCents: number
  runningCents: number
}

export const LEDGER_CSV_COLUMNS = [
  'number',
  'entry_date',
  'line_no',
  'type',
  'source_type',
  'source_id',
  'entry_memo',
  'line_memo',
  'store_id',
  'party_type',
  'party_id',
  'debit_cents',
  'credit_cents',
  'running_cents'
] as const

export const ledgerCsv = (rows: readonly LedgerCsvRow[]): string =>
  csvHeader(LEDGER_CSV_COLUMNS) +
  rows
    .map(row =>
      csvLine([
        row.number,
        row.entryDate,
        row.lineNo,
        row.type,
        row.sourceType,
        row.sourceId,
        row.entryMemo,
        row.lineMemo,
        row.storeId,
        row.partyType,
        row.partyId,
        row.debitCents,
        row.creditCents,
        row.runningCents
      ])
    )
    .join('')

export interface TrialBalanceCsvRow {
  code: string
  name: string
  type: string
  debitCents: number
  creditCents: number
  balanceCents: number
}

export const TRIAL_BALANCE_CSV_COLUMNS = [
  'code',
  'name',
  'type',
  'debit_cents',
  'credit_cents',
  'balance_cents'
] as const

export const trialBalanceCsv = (rows: readonly TrialBalanceCsvRow[]): string =>
  csvHeader(TRIAL_BALANCE_CSV_COLUMNS) +
  rows
    .map(row =>
      csvLine([row.code, row.name, row.type, row.debitCents, row.creditCents, row.balanceCents])
    )
    .join('')
