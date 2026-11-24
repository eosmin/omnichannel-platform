import { z } from 'zod'

import { ApiRoutesFinance } from '@platform/core/api'
import type { AgingKind } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The statements and the lists with age of the books (TDD_18 §10; Step 4B.9b-3): the income statement and the cash flow of a range
// of days, the balance sheet of a day and the payables or receivables as of a day, each as an answer and as the CSV the api writes.
// Reading asks for finance:view_reports and a file for finance:export besides; the api checks both on every call. A sum is whole cents of
// US dollars and a string of digits, because it can pass the 32 bits of a line: the screen never turns it into a float. A day is
// 'YYYY-MM-DD'. A report with no `storeId` covers the whole organization; with one it is a slice of that store.

const signedCents = z.string().regex(/^-?\d+$/)

const rowSchema = z.object({
  accountId: z.string(),
  code: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  isPostable: z.boolean(),
  balanceCents: signedCents,
  rollupCents: signedCents
})
export type FinanceStatementRowView = z.output<typeof rowSchema>

const sectionSchema = z.object({ rows: z.array(rowSchema), totalCents: signedCents })
export type FinanceStatementSectionView = z.output<typeof sectionSchema>

// What the report could not say whole: the api names it, the screen shows it (a statement that looks complete and is not is the worst one)
const warningsSchema = z.array(z.string())

const incomeStatementSchema = z.object({
  from: z.string(),
  to: z.string(),
  storeId: z.string().nullable(),
  income: sectionSchema,
  costOfSales: sectionSchema,
  expenses: sectionSchema,
  grossMarginCents: signedCents,
  netResultCents: signedCents,
  warnings: warningsSchema
})
export type FinanceIncomeStatementView = z.output<typeof incomeStatementSchema>

const balanceSheetSchema = z.object({
  asOf: z.string(),
  storeId: z.string().nullable(),
  assets: sectionSchema,
  liabilities: sectionSchema,
  equity: sectionSchema,
  resultCents: signedCents,
  equityWithResultCents: signedCents,
  // null for the slice of one store: its lines need not balance by themselves
  balanced: z.boolean().nullable(),
  warnings: warningsSchema
})
export type FinanceBalanceSheetView = z.output<typeof balanceSheetSchema>

const cashFlowSchema = z.object({
  from: z.string(),
  to: z.string(),
  storeId: z.string().nullable(),
  sources: z.array(
    z.object({
      source: z.string(),
      inflowCents: signedCents,
      outflowCents: signedCents,
      netCents: signedCents
    })
  ),
  inflowCents: signedCents,
  outflowCents: signedCents,
  netCents: signedCents,
  openingCents: signedCents,
  closingCents: signedCents,
  closes: z.boolean(),
  warnings: warningsSchema
})
export type FinanceCashFlowView = z.output<typeof cashFlowSchema>

const agingRowSchema = z.object({
  partyType: z.string().nullable(),
  partyId: z.string().nullable(),
  partyName: z.string().nullable(),
  bucketsCents: z.array(signedCents),
  unappliedCents: signedCents,
  totalCents: signedCents
})
export type FinanceAgingRowView = z.output<typeof agingRowSchema>

const agingSchema = z.object({
  kind: z.string(),
  asOf: z.string(),
  storeId: z.string().nullable(),
  // The upper bounds, in days, of every bucket but the last
  bucketDays: z.array(z.number().int()),
  rows: z.array(agingRowSchema),
  bucketsCents: z.array(signedCents),
  unappliedCents: signedCents,
  totalCents: signedCents,
  // The roles of this list that have no account mapped in the settings: the report says so instead of choosing one
  missingRoles: z.array(z.string()),
  warnings: warningsSchema
})
export type FinanceAgingView = z.output<typeof agingSchema>

const csvSchema = z.string()

export interface FinanceFlowQuery {
  from: string
  to: string
}
export interface FinanceBalanceSheetQuery {
  asOf: string
}
export interface FinanceAgingQuery {
  kind: AgingKind
  asOf: string
}

const withQuery = (path: string, query: Record<string, string>): string =>
  `${path}?${new URLSearchParams(query).toString()}`

const flowSearch = (query: FinanceFlowQuery): Record<string, string> => ({
  from: query.from,
  to: query.to
})

export function fetchFinanceIncomeStatement(
  client: ApiClient,
  storeId: string,
  query: FinanceFlowQuery,
  signal?: AbortSignal
): Promise<FinanceIncomeStatementView> {
  return client.request(withQuery(ApiRoutesFinance.reports.incomeStatement, flowSearch(query)), {
    schema: incomeStatementSchema,
    storeId,
    signal
  })
}

export function fetchFinanceBalanceSheet(
  client: ApiClient,
  storeId: string,
  query: FinanceBalanceSheetQuery,
  signal?: AbortSignal
): Promise<FinanceBalanceSheetView> {
  return client.request(withQuery(ApiRoutesFinance.reports.balanceSheet, { asOf: query.asOf }), {
    schema: balanceSheetSchema,
    storeId,
    signal
  })
}

export function fetchFinanceCashFlow(
  client: ApiClient,
  storeId: string,
  query: FinanceFlowQuery,
  signal?: AbortSignal
): Promise<FinanceCashFlowView> {
  return client.request(withQuery(ApiRoutesFinance.reports.cashFlow, flowSearch(query)), {
    schema: cashFlowSchema,
    storeId,
    signal
  })
}

export function fetchFinanceAging(
  client: ApiClient,
  storeId: string,
  query: FinanceAgingQuery,
  signal?: AbortSignal
): Promise<FinanceAgingView> {
  return client.request(
    withQuery(ApiRoutesFinance.reports.aging, { kind: query.kind, asOf: query.asOf }),
    { schema: agingSchema, storeId, signal }
  )
}

// The files are the text the api wrote, saved by the page as it came
export function fetchFinanceIncomeStatementCsv(
  client: ApiClient,
  storeId: string,
  query: FinanceFlowQuery
): Promise<string> {
  return client.request(withQuery(ApiRoutesFinance.reports.incomeStatementCsv, flowSearch(query)), {
    schema: csvSchema,
    responseType: 'text',
    storeId
  })
}

export function fetchFinanceBalanceSheetCsv(
  client: ApiClient,
  storeId: string,
  query: FinanceBalanceSheetQuery
): Promise<string> {
  return client.request(withQuery(ApiRoutesFinance.reports.balanceSheetCsv, { asOf: query.asOf }), {
    schema: csvSchema,
    responseType: 'text',
    storeId
  })
}

export function fetchFinanceCashFlowCsv(
  client: ApiClient,
  storeId: string,
  query: FinanceFlowQuery
): Promise<string> {
  return client.request(withQuery(ApiRoutesFinance.reports.cashFlowCsv, flowSearch(query)), {
    schema: csvSchema,
    responseType: 'text',
    storeId
  })
}

export function fetchFinanceAgingCsv(
  client: ApiClient,
  storeId: string,
  query: FinanceAgingQuery
): Promise<string> {
  return client.request(
    withQuery(ApiRoutesFinance.reports.agingCsv, { kind: query.kind, asOf: query.asOf }),
    { schema: csvSchema, responseType: 'text', storeId }
  )
}
