import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import { type FinancePeriodView, periodSchema } from './finance-api'

// The close of a month and the reports of the books (TDD_18 §5, §10, §11; Step 4B.9b-1). A sum that can pass the 32 bits of a line
// is a string of digits, as in `finance-api.ts`: the screen never turns it into a float. Every file is the text the api writes
// (the CSV), saved by the page as it came.

const cents = z.string().regex(/^\d+$/)
const signedCents = z.string().regex(/^-?\d+$/)

const trialBalanceRowSchema = z.object({
  accountId: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  debitCents: cents,
  creditCents: cents,
  // On the side where the account normally sits
  balanceCents: signedCents
})
export type FinanceTrialBalanceRowView = z.output<typeof trialBalanceRowSchema>

const trialBalanceSchema = z.object({
  periodId: z.string(),
  storeId: z.string().nullable(),
  rows: z.array(trialBalanceRowSchema),
  totals: z.object({ debitCents: cents, creditCents: cents, balanced: z.boolean() })
})
export type FinanceTrialBalanceView = z.output<typeof trialBalanceSchema>

const ledgerLineSchema = z.object({
  entryId: z.string(),
  number: z.string(),
  entryDate: z.string(),
  lineNo: z.number().int(),
  type: z.string(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  entryMemo: z.string().nullable(),
  lineMemo: z.string().nullable(),
  storeId: z.string().nullable(),
  partyType: z.string().nullable(),
  partyId: z.string().nullable(),
  debitCents: cents,
  creditCents: cents,
  // The balance of the account after this line, on its normal side
  runningCents: signedCents
})
export type FinanceLedgerLineView = z.output<typeof ledgerLineSchema>

const ledgerSchema = z.object({
  account: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    type: z.string(),
    normalSide: z.string()
  }),
  // What the account held before the first line of this page
  openingCents: signedCents,
  lines: z.array(ledgerLineSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type FinanceLedgerView = z.output<typeof ledgerSchema>

const chainSchema = z.object({
  ok: z.boolean(),
  entriesChecked: z.number().int(),
  headNumber: z.string().nullable(),
  headHash: z.string().nullable(),
  // The reason stays text: a break the server names that this page does not know must still draw
  break: z.object({ entryId: z.string(), number: z.string(), reason: z.string() }).nullable(),
  frozenHeads: z.array(
    z.object({
      periodId: z.string(),
      year: z.number().int(),
      month: z.number().int(),
      present: z.boolean()
    })
  )
})
export type FinanceChainVerificationView = z.output<typeof chainSchema>

const csvSchema = z.string()

const withQuery = (path: string, search: URLSearchParams): string => {
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

// Closing takes no body: the month is the one in the path
export function closeFinancePeriod(
  client: ApiClient,
  storeId: string,
  periodId: string
): Promise<FinancePeriodView> {
  return client.request(ApiRoutes.finance.periods.close(encodeURIComponent(periodId)), {
    method: 'POST',
    schema: periodSchema,
    storeId
  })
}

// Only the latest closed month, with the reason that stays in the trail of the books
export function reopenFinancePeriod(
  client: ApiClient,
  storeId: string,
  periodId: string,
  input: { reason: string }
): Promise<FinancePeriodView> {
  return client.request(ApiRoutes.finance.periods.reopen(encodeURIComponent(periodId)), {
    method: 'POST',
    body: input,
    schema: periodSchema,
    storeId
  })
}

export function fetchFinanceTrialBalance(
  client: ApiClient,
  storeId: string,
  periodId: string,
  signal?: AbortSignal
): Promise<FinanceTrialBalanceView> {
  return client.request(
    withQuery(ApiRoutes.finance.reports.trialBalance, new URLSearchParams({ periodId })),
    { schema: trialBalanceSchema, storeId, signal }
  )
}

export interface FinanceLedgerQuery {
  accountId: string
  // Either end may be null (open): a day, 'YYYY-MM-DD'
  from: string | null
  to: string | null
  cursor: string | null
}

export function fetchFinanceLedger(
  client: ApiClient,
  storeId: string,
  query: FinanceLedgerQuery,
  signal?: AbortSignal
): Promise<FinanceLedgerView> {
  const search = new URLSearchParams({ accountId: query.accountId })
  if (query.from !== null) search.set('from', query.from)
  if (query.to !== null) search.set('to', query.to)
  if (query.cursor !== null) search.set('cursor', query.cursor)
  return client.request(withQuery(ApiRoutes.finance.reports.ledger, search), {
    schema: ledgerSchema,
    storeId,
    signal
  })
}

export function fetchFinanceTrialBalanceCsv(
  client: ApiClient,
  storeId: string,
  periodId: string
): Promise<string> {
  return client.request(
    withQuery(ApiRoutes.finance.reports.trialBalanceCsv, new URLSearchParams({ periodId })),
    { schema: csvSchema, responseType: 'text', storeId }
  )
}

export function fetchFinanceLedgerCsv(
  client: ApiClient,
  storeId: string,
  input: { accountId: string; from: string; to: string }
): Promise<string> {
  return client.request(
    withQuery(ApiRoutes.finance.reports.ledgerCsv, new URLSearchParams(input)),
    {
      schema: csvSchema,
      responseType: 'text',
      storeId
    }
  )
}

export function fetchFinanceJournalCsv(
  client: ApiClient,
  storeId: string,
  input: { from: string; to: string }
): Promise<string> {
  return client.request(
    withQuery(ApiRoutes.finance.reports.journalCsv, new URLSearchParams(input)),
    { schema: csvSchema, responseType: 'text', storeId }
  )
}

// The check of the hash chain, on demand for the auditor: it leaves an audit row
export function verifyFinanceChain(
  client: ApiClient,
  storeId: string
): Promise<FinanceChainVerificationView> {
  return client.request(ApiRoutes.finance.reports.verifyChain, {
    method: 'POST',
    schema: chainSchema,
    storeId
  })
}
