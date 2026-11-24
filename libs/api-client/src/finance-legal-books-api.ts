import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type { LegalBookKind } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The legal books of the organization (TDD_18 §7; Step 4B.9b-3): a book is a read-only report over the ledger for one month, with the
// layout the organization keeps for its kind. **[ACCOUNTANT]** The layout is not validated until an accountant confirms it: every answer
// carries `unvalidated`, and the screen says so wherever it is true. Reading a book, its file or the frozen list asks for
// finance:view_reports and finance:export; the layouts need only the first. A money cell and a total are whole cents (a number the api
// keeps within the safe integers), never a float of dollars.

const columnSchema = z.object({ field: z.string(), label: z.string().nullable() })
export type FinanceBookColumnView = z.output<typeof columnSchema>

const layoutSchema = z.object({
  kind: z.string(),
  // 0 is the proposal of the code, 1 and up are the versions the organization wrote
  version: z.number().int(),
  source: z.string(),
  accountantConfirmed: z.boolean(),
  columns: z.array(columnSchema),
  sort: z.string(),
  correlativeStart: z.number().int(),
  correlativeRestart: z.string(),
  unissuedSales: z.string(),
  createdAt: z.string().nullable()
})
export type FinanceBookLayoutView = z.output<typeof layoutSchema>

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type FinanceBookCell = z.output<typeof cellSchema>

// What the book could not list, counted so that a file that looks whole is not one that left sales out
const warningsSchema = z.object({
  salesWithoutTaxSnapshot: z.number().int(),
  salesNotReadable: z.number().int(),
  voidedDocuments: z.number().int(),
  unclassifiedDocuments: z.number().int(),
  returnsNotListed: z.number().int()
})
export type FinanceBookWarningsView = z.output<typeof warningsSchema>

const bookSchema = z.object({
  kind: z.string(),
  period: z.object({
    id: z.string(),
    year: z.number().int(),
    month: z.number().int(),
    from: z.string(),
    to: z.string(),
    status: z.string()
  }),
  layout: z.object({
    version: z.number().int(),
    source: z.string(),
    accountantConfirmed: z.boolean()
  }),
  // True while the layout is the proposal or no accountant confirmed it: the book is a draft, not the legal book
  unvalidated: z.boolean(),
  header: z.array(z.string()),
  rows: z.array(z.array(cellSchema)),
  totals: z.record(z.string(), z.number()),
  warnings: warningsSchema,
  contentSha256: z.string(),
  // True when the book is the one frozen at the close of its month (served from the snapshot, not rebuilt)
  frozen: z.boolean()
})
export type FinanceBookView = z.output<typeof bookSchema>

const frozenBookSchema = z.object({
  id: z.string(),
  periodId: z.string(),
  kind: z.string(),
  layoutVersion: z.number().int(),
  closedAt: z.string(),
  contentSha256: z.string(),
  createdAt: z.string()
})
export type FinanceFrozenBookView = z.output<typeof frozenBookSchema>

const csvSchema = z.string()

export interface FinanceBookQuery {
  kind: LegalBookKind
  periodId: string
}

const withQuery = (path: string, query: Record<string, string>): string => {
  const search = new URLSearchParams(query).toString()
  return search === '' ? path : `${path}?${search}`
}

export function fetchFinanceBookLayouts(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceBookLayoutView[]> {
  return client.request(ApiRoutes.finance.bookLayouts.list, {
    schema: z.array(layoutSchema),
    storeId,
    signal
  })
}

export function fetchFinanceBook(
  client: ApiClient,
  storeId: string,
  query: FinanceBookQuery,
  signal?: AbortSignal
): Promise<FinanceBookView> {
  return client.request(
    withQuery(ApiRoutes.finance.books.byKind(query.kind), { periodId: query.periodId }),
    { schema: bookSchema, storeId, signal }
  )
}

// The file of a book: the text the api wrote (its state, `unvalidated`, travels in the headers and in the book itself)
export function fetchFinanceBookCsv(
  client: ApiClient,
  storeId: string,
  query: FinanceBookQuery
): Promise<string> {
  return client.request(
    withQuery(ApiRoutes.finance.books.csvByKind(query.kind), { periodId: query.periodId }),
    { schema: csvSchema, responseType: 'text', storeId }
  )
}

// The books frozen at the close of a month, newest first
export function fetchFinanceFrozenBooks(
  client: ApiClient,
  storeId: string,
  periodId: string,
  signal?: AbortSignal
): Promise<FinanceFrozenBookView[]> {
  return client.request(withQuery(ApiRoutes.finance.frozenBooks.list, { periodId }), {
    schema: z.array(frozenBookSchema),
    storeId,
    signal
  })
}

export function fetchFinanceFrozenBook(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<FinanceBookView> {
  return client.request(ApiRoutes.finance.frozenBooks.byId(id), {
    schema: bookSchema,
    storeId,
    signal
  })
}
