import { VatCsvSide, VatWarningKind } from '@platform/core/domain'
import { csvHeader, csvLine } from '@platform/core/exports'

import type { VatReportView } from './finance.views'

// The columns of the VAT report as a CSV (TDD_18 §7): one row per month, side, kind of line and rate. Amounts are whole cents, the
// rate is basis points (13 % is 1300), the base is empty on the input side. The cells go through the same writer as every other
// export, so a text that starts like a formula is written as text.
export const VAT_REPORT_COLUMNS = [
  'month',
  'side',
  'kind',
  'rate_bps',
  'base_cents',
  'tax_cents',
  'documents'
] as const

// Beside the rows of the report the file carries the monthly balance (side `balance`: output tax less input tax, in `tax_cents`) and what
// the report could not read or counted apart (side `warning`, the count in `documents`), so a file that looks complete is not one that
// left orders out
export function vatReportCsv(report: VatReportView): string {
  const rows = report.rows.map(row =>
    csvLine([
      row.month,
      row.side,
      row.kind,
      row.rateBps,
      row.baseCents,
      row.taxCents,
      row.documents
    ])
  )
  const balances = report.months.map(month =>
    csvLine([month.month, VatCsvSide.BALANCE, '', null, null, month.balanceCents, null])
  )
  const warnings: [VatWarningKind, number][] = [
    [VatWarningKind.ORDERS_WITHOUT_TAX_SNAPSHOT, report.ordersWithoutTaxSnapshot],
    [VatWarningKind.ORDERS_NOT_READABLE, report.ordersNotReadable],
    [VatWarningKind.RETURNED_ORDERS_INCLUDED, report.returnedOrdersIncluded]
  ]
  return (
    csvHeader(VAT_REPORT_COLUMNS) +
    [
      ...rows,
      ...balances,
      ...warnings
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => csvLine(['', VatCsvSide.WARNING, kind, null, null, null, count]))
    ].join('')
  )
}
