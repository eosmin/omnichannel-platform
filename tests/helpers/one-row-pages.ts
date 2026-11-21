import { FinanceReportLimits } from '@platform/core/domain'

// Every report of Finance reads one row per unit (Step 7.3-D): imported FIRST by the spec that runs the suites of the figures again, so the
// pages are set before any service reads them. Only this file's process is changed: the constants are read from the module of the test.
const ONE_ROW = 1
const limits = FinanceReportLimits as {
  -readonly [Key in keyof typeof FinanceReportLimits]: number
}
limits.MARGIN_PAGE_SIZE = ONE_ROW
limits.BOOK_PAGE_SIZE = ONE_ROW
limits.VAT_PAGE_SIZE = ONE_ROW
limits.CSV_PAGE_SIZE = ONE_ROW
