import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'

// The VAT of a period, the margin by product and the weekly check of the chain (TDD_18 §7, §10, §11; Step 4B.9b-4a). Reading the VAT asks
// for finance:view, the margin and the state of the chain for finance:view_reports, and a file for finance:export besides; the api checks
// every call. Every amount is whole cents of US dollars as a JSON integer (these answers add to far less than 2^53) and the screen never
// turns it into a float. A day is 'YYYY-MM-DD'. A report only reads: it never writes the books.

const cents = z.number().int()
const nullableCents = cents.nullable()

const vatRowSchema = z.object({
  month: z.string(),
  side: z.string(),
  kind: z.string(),
  rateBps: z.number().int().nullable(),
  // The input side carries no base: the journal holds the tax and not the amount it was charged on
  baseCents: nullableCents,
  taxCents: cents,
  documents: z.number().int()
})
export type FinanceVatRowView = z.output<typeof vatRowSchema>

const vatMonthSchema = z.object({
  month: z.string(),
  outputTaxCents: cents,
  inputTaxCents: cents,
  // Output less input: positive is to pay, negative is carried forward
  balanceCents: cents
})
export type FinanceVatMonthView = z.output<typeof vatMonthSchema>

const vatSchema = z.object({
  from: z.string(),
  to: z.string(),
  currency: z.string(),
  recognizedOn: z.string(),
  accountingStartDate: z.string(),
  rows: z.array(vatRowSchema),
  months: z.array(vatMonthSchema),
  ordersWithoutTaxSnapshot: z.number().int(),
  ordersNotReadable: z.number().int(),
  returnedOrdersIncluded: z.number().int()
})
export type FinanceVatView = z.output<typeof vatSchema>

const marginRowSchema = z.object({
  storeId: z.string(),
  productId: z.string(),
  productName: z.string().nullable(),
  unitsSold: z.number().int(),
  revenueCents: cents,
  costCents: cents,
  marginCents: cents,
  // Basis points of the revenue; null when there is no revenue to divide by
  marginBps: z.number().int().nullable()
})
export type FinanceMarginRowView = z.output<typeof marginRowSchema>

const marginSchema = z.object({
  from: z.string(),
  to: z.string(),
  storeId: z.string().nullable(),
  rows: z.array(marginRowSchema),
  totals: z.object({
    unitsSold: z.number().int(),
    revenueCents: cents,
    costCents: cents,
    marginCents: cents,
    marginBps: z.number().int().nullable()
  }),
  // The ledger's figures for the same sale entries: null when the role has no account mapped (never zero)
  ledger: z.object({
    revenueCents: nullableCents,
    costCents: nullableCents,
    revenueDifferenceCents: nullableCents,
    costDifferenceCents: nullableCents
  }),
  returns: z.object({ revenueCents: nullableCents, costCents: nullableCents }),
  ordersUsed: z.number().int(),
  ordersNotReadable: z.number().int(),
  unvaluedUnits: z.number().int(),
  warnings: z.array(z.string())
})
export type FinanceMarginView = z.output<typeof marginSchema>

const chainStatusSchema = z.object({
  open: z
    .object({
      reason: z.string(),
      entryNumber: z.string().nullable(),
      entriesChecked: z.number().int(),
      detectedAt: z.string(),
      lastSeenAt: z.string()
    })
    .nullable()
})
export type FinanceChainStatusView = z.output<typeof chainStatusSchema>

const csvSchema = z.string()

export interface FinanceRangeQuery {
  from: string
  to: string
}

const rangeSearch = (path: string, query: FinanceRangeQuery): string =>
  `${path}?${new URLSearchParams({ from: query.from, to: query.to }).toString()}`

export function fetchFinanceVat(
  client: ApiClient,
  storeId: string,
  query: FinanceRangeQuery,
  signal?: AbortSignal
): Promise<FinanceVatView> {
  return client.request(rangeSearch(ApiRoutes.finance.reports.vat, query), {
    schema: vatSchema,
    storeId,
    signal
  })
}

export function fetchFinanceMargin(
  client: ApiClient,
  storeId: string,
  query: FinanceRangeQuery,
  signal?: AbortSignal
): Promise<FinanceMarginView> {
  return client.request(rangeSearch(ApiRoutes.finance.reports.margin, query), {
    schema: marginSchema,
    storeId,
    signal
  })
}

export function fetchFinanceChainStatus(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceChainStatusView> {
  return client.request(ApiRoutes.finance.reports.chainStatus, {
    schema: chainStatusSchema,
    storeId,
    signal
  })
}

// The files are the text the api wrote, saved by the page as it came
export function fetchFinanceVatCsv(
  client: ApiClient,
  storeId: string,
  query: FinanceRangeQuery
): Promise<string> {
  return client.request(rangeSearch(ApiRoutes.finance.reports.vatCsv, query), {
    schema: csvSchema,
    responseType: 'text',
    storeId
  })
}

export function fetchFinanceMarginCsv(
  client: ApiClient,
  storeId: string,
  query: FinanceRangeQuery
): Promise<string> {
  return client.request(rangeSearch(ApiRoutes.finance.reports.marginCsv, query), {
    schema: csvSchema,
    responseType: 'text',
    storeId
  })
}
