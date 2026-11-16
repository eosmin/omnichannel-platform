import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'
import { mediaUrlsSchema, type MediaUrlsView } from './media-api'

// The journal and the expenses, incomes and transfers registered by hand (TDD_18 §4.2, §4.3; Step 4B.9a-2). Reading is for
// finance:view_journal. Writing an entry takes finance:post_manual, and a transaction the permission of its kind
// (finance:manage_transactions for an expense or an income, finance:move_money for a transfer); the api checks them on every call.
// An amount is whole cents of one line (an Int of the database, so a number is exact); a date is a day ('YYYY-MM-DD').

const entrySchema = z.object({
  id: z.string(),
  // The gapless number of the journal: a BigInt of the database, a string of digits here
  number: z.string().regex(/^\d+$/),
  entryDate: z.string(),
  periodId: z.string(),
  type: z.string(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  sourceDate: z.string().nullable(),
  reversesEntryId: z.string().nullable(),
  reversedByEntryId: z.string().nullable(),
  memo: z.string().nullable(),
  currency: z.string(),
  totalCents: z.number().int(),
  createdBy: z.string().nullable(),
  origin: z.string(),
  createdAt: z.string()
})
export type FinanceEntryView = z.output<typeof entrySchema>

const entryLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  accountId: z.string(),
  storeId: z.string().nullable(),
  debitCents: z.number().int(),
  creditCents: z.number().int(),
  memo: z.string().nullable()
})
export type FinanceEntryLineView = z.output<typeof entryLineSchema>

const entryDetailSchema = entrySchema.extend({ lines: z.array(entryLineSchema) })
export type FinanceEntryDetailView = z.output<typeof entryDetailSchema>

const entryPageSchema = z.object({
  data: z.array(entrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type FinanceEntryPageView = z.output<typeof entryPageSchema>

const transactionSchema = z.object({
  id: z.string(),
  storeId: z.string().nullable(),
  kind: z.string(),
  occurredOn: z.string(),
  amountCents: z.number().int(),
  fromAccountId: z.string().nullable(),
  toAccountId: z.string().nullable(),
  categoryAccountId: z.string().nullable(),
  taxRateId: z.string().nullable(),
  taxCents: z.number().int(),
  taxCreditable: z.boolean(),
  documentNumber: z.string().nullable(),
  documentMediaId: z.string().nullable(),
  memo: z.string().nullable(),
  entryId: z.string(),
  voidedByEntryId: z.string().nullable(),
  voided: z.boolean(),
  replacesTransactionId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string()
})
export type FinanceTransactionView = z.output<typeof transactionSchema>

const transactionPageSchema = z.object({
  data: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type FinanceTransactionPageView = z.output<typeof transactionPageSchema>

const withQuery = (path: string, search: URLSearchParams): string => {
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

// What the list is narrowed by: a key left out (or empty) is not a filter
export interface FinanceEntryFilters {
  type?: string
  accountId?: string
  from?: string
  to?: string
}

export interface FinanceTransactionFilters {
  kind?: string
  accountId?: string
  from?: string
  to?: string
  includeVoided?: boolean
}

function searchOf(
  filters: Record<string, string | boolean | undefined>,
  cursor: string | null
): URLSearchParams {
  const search = new URLSearchParams({ limit: String(PaginationLimits.DEFAULT) })
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '' || value === false) continue
    search.set(key, String(value))
  }
  if (cursor !== null) search.set('cursor', cursor)
  return search
}

export function fetchFinanceEntryPage(
  client: ApiClient,
  storeId: string,
  filters: FinanceEntryFilters,
  cursor: string | null,
  signal?: AbortSignal
): Promise<FinanceEntryPageView> {
  return client.request(
    withQuery(ApiRoutes.finance.entries.list, searchOf({ ...filters }, cursor)),
    {
      schema: entryPageSchema,
      storeId,
      signal
    }
  )
}

export function fetchFinanceEntry(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<FinanceEntryDetailView> {
  return client.request(ApiRoutes.finance.entries.byId(encodeURIComponent(id)), {
    schema: entryDetailSchema,
    storeId,
    signal
  })
}

export interface ManualFinanceEntryLineInput {
  accountId: string
  debitCents: number
  creditCents: number
  memo?: string
}

export interface ManualFinanceEntryInput {
  // Once per form: a double click or a retry after a lost answer posts once
  idempotencyKey: string
  entryDate: string
  type: string
  memo: string
  lines: ManualFinanceEntryLineInput[]
}

export function postManualFinanceEntry(
  client: ApiClient,
  storeId: string,
  input: ManualFinanceEntryInput
): Promise<FinanceEntryDetailView> {
  return client.request(ApiRoutes.finance.entries.manual, {
    method: 'POST',
    body: input,
    schema: entryDetailSchema,
    storeId
  })
}

export function reverseFinanceEntry(
  client: ApiClient,
  storeId: string,
  id: string,
  input: { memo: string; entryDate?: string }
): Promise<FinanceEntryDetailView> {
  return client.request(ApiRoutes.finance.entries.reverse(encodeURIComponent(id)), {
    method: 'POST',
    body: input,
    schema: entryDetailSchema,
    storeId
  })
}

export function fetchFinanceTransactionPage(
  client: ApiClient,
  storeId: string,
  filters: FinanceTransactionFilters,
  cursor: string | null,
  signal?: AbortSignal
): Promise<FinanceTransactionPageView> {
  return client.request(
    withQuery(ApiRoutes.finance.transactions.list, searchOf({ ...filters }, cursor)),
    { schema: transactionPageSchema, storeId, signal }
  )
}

export function fetchFinanceTransaction(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<FinanceTransactionView> {
  return client.request(ApiRoutes.finance.transactions.byId(encodeURIComponent(id)), {
    schema: transactionSchema,
    storeId,
    signal
  })
}

export interface RecordFinanceTransactionInput {
  // Once per content: a retry after a lost answer sends the same key and the same content, and registers once
  idempotencyKey: string
  kind: string
  occurredOn: string
  // What was paid or received, tax included; the tax is computed by the api from the rate, never sent
  amountCents: number
  fromAccountId?: string
  toAccountId?: string
  categoryAccountId?: string
  taxRateId?: string
  taxCreditable?: boolean
  documentNumber?: string
  memo?: string
}

export function recordFinanceTransaction(
  client: ApiClient,
  storeId: string,
  input: RecordFinanceTransactionInput
): Promise<FinanceTransactionView> {
  return client.request(ApiRoutes.finance.transactions.record, {
    method: 'POST',
    body: input,
    schema: transactionSchema,
    storeId
  })
}

export function voidFinanceTransaction(
  client: ApiClient,
  storeId: string,
  id: string,
  reason: string
): Promise<FinanceTransactionView> {
  return client.request(ApiRoutes.finance.transactions.void(encodeURIComponent(id)), {
    method: 'POST',
    body: { reason },
    schema: transactionSchema,
    storeId
  })
}

// Voids one and registers another, in one act
export function replaceFinanceTransaction(
  client: ApiClient,
  storeId: string,
  id: string,
  input: { reason: string; replacement: RecordFinanceTransactionInput }
): Promise<FinanceTransactionView> {
  return client.request(ApiRoutes.finance.transactions.replace(encodeURIComponent(id)), {
    method: 'POST',
    body: input,
    schema: transactionSchema,
    storeId
  })
}

// The receipt is set once, with a file that the scan found clean and that was uploaded for this transaction
export function attachFinanceTransactionDocument(
  client: ApiClient,
  storeId: string,
  id: string,
  mediaId: string
): Promise<FinanceTransactionView> {
  return client.request(ApiRoutes.finance.transactions.document(encodeURIComponent(id)), {
    method: 'POST',
    body: { mediaId },
    schema: transactionSchema,
    storeId
  })
}

// The signed links of the receipt: they expire in minutes, so they are asked when the file is opened and never stored
export function fetchFinanceTransactionDocumentUrls(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<MediaUrlsView> {
  return client.request(ApiRoutes.finance.transactions.document(encodeURIComponent(id)), {
    schema: mediaUrlsSchema,
    storeId,
    signal
  })
}
