// The equivalence of the reports of Finance before and after they were paged (Step 7.3-D, debt (c) of F6-3 "finance reports of the whole
// organization"): the numbers of a report must not depend on how many rows each unit reads. The suites below pin the figures of the margin
// (with returns), the legal books (an open month, a closed and frozen one, an empty one, the purchases), the statements and the aging
// (several lines of a party across pages) and the VAT (with the manual incomes), each against the exact cents of its fixture. They run
// again here with a page of ONE row in every report (the helper is imported first, so the pages are set before any service reads them): a
// page boundary that lost, repeated or reordered a line would change a figure and fail the same assertion. The suites themselves run with
// the default pages.
import '../helpers/one-row-pages'
import './finance-margin.spec'
import './finance-margin-returns.spec'
import './finance-books.spec'
import './finance-statements.spec'
import './finance-vat-manual-income.spec'
import './finance-tax-orders.spec'
