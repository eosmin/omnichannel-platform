import { csvHeader, csvLine } from '@platform/core/exports'

import type { MarginView } from './finance-margin.service'

// The margin by product as a CSV (TDD_18 §10): one row per store and product, then the totals, the ledger's figures, what the returns took
// back and what the report could not use. Amounts are whole cents written as numbers, every text goes through the writer of the other
// exports (a product named like a formula is written as text). A figure the ledger could not give is an empty cell, never a zero.
export const MARGIN_CSV_COLUMNS = [
  'section',
  'store_id',
  'product_id',
  'name',
  'units_sold',
  'revenue_cents',
  'cost_cents',
  'margin_cents',
  'margin_bps'
] as const

export interface MarginCsvRow {
  section: string
  storeId: string | null
  productId: string | null
  name: string | null
  unitsSold: number | null
  revenueCents: number | null
  costCents: number | null
  marginCents: number | null
  marginBps: number | null
}

export const marginCsv = (rows: readonly MarginCsvRow[]): string =>
  csvHeader(MARGIN_CSV_COLUMNS) +
  rows
    .map(row =>
      csvLine([
        row.section,
        row.storeId,
        row.productId,
        row.name,
        row.unitsSold,
        row.revenueCents,
        row.costCents,
        row.marginCents,
        row.marginBps
      ])
    )
    .join('')

export type { MarginView }
