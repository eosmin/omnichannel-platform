import { z } from 'zod'

import { ApiRoutesFinance } from '@platform/core/api'
import { PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The books of the organization of the store in X-Store-Id (TDD_18 §12, Step 4B.9a-1: the setup, the settings, the chart, the maps
// of roles and payment methods, the tax rates, the periods and the balances). Reading asks for finance:view and changing for
// finance:manage_accounts; the api checks both on every call. A date is a day ('YYYY-MM-DD'), an amount is whole cents, and a sum
// that can pass the 32 bits of a line is a string of digits (the screen never turns it into a float: `balanceCentsOf`).

const settingsSchema = z.object({
  countryCode: z.string(),
  baseCurrency: z.string(),
  accountingStartDate: z.string(),
  lockedThrough: z.string().nullable(),
  recognizeSaleOn: z.string(),
  roundingAccountId: z.string().nullable(),
  taxRounding: z.string(),
  shippingTaxed: z.boolean(),
  updatedAt: z.string()
})
export type FinanceSettingsView = z.output<typeof settingsSchema>

const setupStateSchema = z.object({
  ready: z.boolean(),
  countries: z.array(z.string()),
  settings: settingsSchema.nullable()
})
export type FinanceSetupView = z.output<typeof setupStateSchema>

const accountSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  normalSide: z.string(),
  parentId: z.string().nullable(),
  isPostable: z.boolean(),
  cashKind: z.string().nullable(),
  isSystem: z.boolean(),
  active: z.boolean(),
  currency: z.string(),
  createdAt: z.string()
})
export type FinanceAccountView = z.output<typeof accountSchema>

const accountPageSchema = z.object({
  data: z.array(accountSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type FinanceAccountPageView = z.output<typeof accountPageSchema>

const roleMappingSchema = z.object({ role: z.string(), accountId: z.string() })
export type FinanceRoleMappingView = z.output<typeof roleMappingSchema>

const paymentAccountSchema = z.object({
  id: z.string(),
  paymentMethod: z.string(),
  // null is the default of the organization
  storeId: z.string().nullable(),
  accountId: z.string()
})
export type FinancePaymentAccountView = z.output<typeof paymentAccountSchema>

const taxRateSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  // Basis points: 13 % is 1300
  rateBps: z.number().int(),
  kind: z.string(),
  outputAccountId: z.string(),
  inputAccountId: z.string(),
  active: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type FinanceTaxRateView = z.output<typeof taxRateSchema>

const storeTaxSettingsSchema = z.object({ pricesIncludeTax: z.boolean() })
export type FinanceStoreTaxSettingsView = z.output<typeof storeTaxSettingsSchema>

export const periodSchema = z.object({
  id: z.string(),
  year: z.number().int(),
  month: z.number().int(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: z.string(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenedBy: z.string().nullable(),
  reopenReason: z.string().nullable(),
  closingHash: z.string().nullable(),
  hasEnded: z.boolean(),
  hasStarted: z.boolean()
})
export type FinancePeriodView = z.output<typeof periodSchema>

const periodPageSchema = z.object({
  data: z.array(periodSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type FinancePeriodPageView = z.output<typeof periodPageSchema>

const balanceSchema = z.object({
  accountId: z.string(),
  debitCents: z.string().regex(/^\d+$/),
  creditCents: z.string().regex(/^\d+$/),
  // On the side where the account grows; negative when it sits on the other one
  balanceCents: z.string().regex(/^-?\d+$/)
})
export type FinanceBalanceView = z.output<typeof balanceSchema>
const balancesSchema = z.object({ data: z.array(balanceSchema) })

const postingSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  eventKind: z.string(),
  reason: z.string(),
  attempts: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type FinancePostingView = z.output<typeof postingSchema>

const postingPageSchema = z.object({
  data: z.array(postingSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type FinancePostingPageView = z.output<typeof postingPageSchema>

const retrySchema = z.object({ data: z.object({ queued: z.literal(true) }) })

// The pages are followed up to the bound the api itself keeps (2000 accounts, a period a month), never further, so a cursor
// that never ends cannot loop. A list that is still not over at the bound is a failure, never a shorter list that looks complete.
const MAX_PAGES = 40

async function allPages<T>(
  read: (
    cursor: string | null
  ) => Promise<{ data: T[]; nextCursor: string | null; hasMore: boolean }>
): Promise<T[]> {
  const found: T[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page: { data: T[]; nextCursor: string | null; hasMore: boolean } = await read(cursor)
    found.push(...page.data)
    if (!page.hasMore || page.nextCursor === null) return found
    cursor = page.nextCursor
  }
  throw new Error('a finance list did not end within the pages the api keeps')
}

const withQuery = (path: string, search: URLSearchParams): string => {
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

export function fetchFinanceSetup(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceSetupView> {
  return client.request(ApiRoutesFinance.setup, { schema: setupStateSchema, storeId, signal })
}

// Sets the books up once. The date is the first day events are posted from; the first day of this month when it is left out.
export function setUpFinance(
  client: ApiClient,
  storeId: string,
  input: { countryCode: string; accountingStartDate?: string }
): Promise<FinanceSetupView> {
  return client.request(ApiRoutesFinance.setup, {
    method: 'POST',
    body: input,
    schema: setupStateSchema,
    storeId
  })
}

export function fetchFinanceSettings(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceSettingsView> {
  return client.request(ApiRoutesFinance.settings, { schema: settingsSchema, storeId, signal })
}

export interface UpdateFinanceSettingsInput {
  recognizeSaleOn?: string
  taxRounding?: string
  shippingTaxed?: boolean
  roundingAccountId?: string
}

export function updateFinanceSettings(
  client: ApiClient,
  storeId: string,
  input: UpdateFinanceSettingsInput
): Promise<FinanceSettingsView> {
  return client.request(ApiRoutesFinance.settings, {
    method: 'PATCH',
    body: input,
    schema: settingsSchema,
    storeId
  })
}

export function fetchAllFinanceAccounts(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceAccountView[]> {
  return allPages(cursor => {
    const search = new URLSearchParams({ limit: String(PaginationLimits.MAX) })
    if (cursor !== null) search.set('cursor', cursor)
    return client.request(withQuery(ApiRoutesFinance.accounts.list, search), {
      schema: accountPageSchema,
      storeId,
      signal
    })
  })
}

export interface CreateFinanceAccountInput {
  code: string
  name: string
  type: string
  parentId?: string | null
  isPostable?: boolean
  cashKind?: string | null
}

// Only the keys that change
export type UpdateFinanceAccountInput = Partial<CreateFinanceAccountInput>

export function createFinanceAccount(
  client: ApiClient,
  storeId: string,
  input: CreateFinanceAccountInput
): Promise<FinanceAccountView> {
  return client.request(ApiRoutesFinance.accounts.create, {
    method: 'POST',
    body: input,
    schema: accountSchema,
    storeId
  })
}

export function updateFinanceAccount(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateFinanceAccountInput
): Promise<FinanceAccountView> {
  return client.request(ApiRoutesFinance.accounts.byId(encodeURIComponent(id)), {
    method: 'PATCH',
    body: input,
    schema: accountSchema,
    storeId
  })
}

export function setFinanceAccountActive(
  client: ApiClient,
  storeId: string,
  id: string,
  active: boolean
): Promise<FinanceAccountView> {
  const route = active
    ? ApiRoutesFinance.accounts.reactivate(encodeURIComponent(id))
    : ApiRoutesFinance.accounts.deactivate(encodeURIComponent(id))
  return client.request(route, { method: 'POST', schema: accountSchema, storeId })
}

export function fetchFinanceAccountRoles(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceRoleMappingView[]> {
  return client.request(ApiRoutesFinance.accountRoles.list, {
    schema: z.array(roleMappingSchema),
    storeId,
    signal
  })
}

export function mapFinanceAccountRole(
  client: ApiClient,
  storeId: string,
  role: string,
  accountId: string
): Promise<FinanceRoleMappingView> {
  return client.request(ApiRoutesFinance.accountRoles.byRole(encodeURIComponent(role)), {
    method: 'PUT',
    body: { accountId },
    schema: roleMappingSchema,
    storeId
  })
}

export function fetchFinancePaymentAccounts(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinancePaymentAccountView[]> {
  return client.request(ApiRoutesFinance.paymentAccounts.list, {
    schema: z.array(paymentAccountSchema),
    storeId,
    signal
  })
}

// `forStoreId` null is the default of the organization; a store id is that store's own choice
export function setFinancePaymentAccount(
  client: ApiClient,
  storeId: string,
  input: { paymentMethod: string; accountId: string; forStoreId: string | null }
): Promise<FinancePaymentAccountView> {
  return client.request(ApiRoutesFinance.paymentAccounts.set, {
    method: 'PUT',
    body: {
      paymentMethod: input.paymentMethod,
      accountId: input.accountId,
      storeId: input.forStoreId
    },
    schema: paymentAccountSchema,
    storeId
  })
}

// Takes a store's own choice away, so the default of the organization applies again
export async function removeFinancePaymentAccount(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<void> {
  await client.request(ApiRoutesFinance.paymentAccounts.byId(encodeURIComponent(id)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

export function fetchFinanceTaxRates(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceTaxRateView[]> {
  return client.request(ApiRoutesFinance.taxRates.list, {
    schema: z.array(taxRateSchema),
    storeId,
    signal
  })
}

export interface CreateFinanceTaxRateInput {
  code: string
  name: string
  rateBps: number
  outputAccountId: string
  inputAccountId: string
  isDefault?: boolean
}

// Only the keys that change; `isDefault` only to make a rate the default (another takes the place when it stops being it)
export interface UpdateFinanceTaxRateInput {
  code?: string
  name?: string
  rateBps?: number
  outputAccountId?: string
  inputAccountId?: string
  isDefault?: true
}

export function createFinanceTaxRate(
  client: ApiClient,
  storeId: string,
  input: CreateFinanceTaxRateInput
): Promise<FinanceTaxRateView> {
  return client.request(ApiRoutesFinance.taxRates.create, {
    method: 'POST',
    body: input,
    schema: taxRateSchema,
    storeId
  })
}

export function updateFinanceTaxRate(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateFinanceTaxRateInput
): Promise<FinanceTaxRateView> {
  return client.request(ApiRoutesFinance.taxRates.byId(encodeURIComponent(id)), {
    method: 'PATCH',
    body: input,
    schema: taxRateSchema,
    storeId
  })
}

export function setFinanceTaxRateActive(
  client: ApiClient,
  storeId: string,
  id: string,
  active: boolean
): Promise<FinanceTaxRateView> {
  const route = active
    ? ApiRoutesFinance.taxRates.reactivate(encodeURIComponent(id))
    : ApiRoutesFinance.taxRates.deactivate(encodeURIComponent(id))
  return client.request(route, { method: 'POST', schema: taxRateSchema, storeId })
}

// The tax preference of the store of the request (not of the organization)
export function fetchFinanceStoreTaxSettings(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinanceStoreTaxSettingsView> {
  return client.request(ApiRoutesFinance.storeTaxSettings, {
    schema: storeTaxSettingsSchema,
    storeId,
    signal
  })
}

export function updateFinanceStoreTaxSettings(
  client: ApiClient,
  storeId: string,
  input: { pricesIncludeTax: boolean; confirmPriceModeChange: true }
): Promise<FinanceStoreTaxSettingsView> {
  return client.request(ApiRoutesFinance.storeTaxSettings, {
    method: 'PATCH',
    body: input,
    schema: storeTaxSettingsSchema,
    storeId
  })
}

export function fetchAllFinancePeriods(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<FinancePeriodView[]> {
  return allPages(cursor => {
    const search = new URLSearchParams({ limit: String(PaginationLimits.MAX) })
    if (cursor !== null) search.set('cursor', cursor)
    return client.request(withQuery(ApiRoutesFinance.periods.list, search), {
      schema: periodPageSchema,
      storeId,
      signal
    })
  })
}

// Opens the period of a month before any entry needs it
export function openFinancePeriod(
  client: ApiClient,
  storeId: string,
  input: { year: number; month: number }
): Promise<FinancePeriodView> {
  return client.request(ApiRoutesFinance.periods.open, {
    method: 'POST',
    body: input,
    schema: periodSchema,
    storeId
  })
}

// The balance of every account with entries, in one period or in all of them
export async function fetchFinanceBalances(
  client: ApiClient,
  storeId: string,
  periodId: string | null,
  signal?: AbortSignal
): Promise<FinanceBalanceView[]> {
  const search = new URLSearchParams()
  if (periodId !== null) search.set('periodId', periodId)
  const answer = await client.request(withQuery(ApiRoutesFinance.balances, search), {
    schema: balancesSchema,
    storeId,
    signal
  })
  return answer.data
}

export function fetchFinancePostingPage(
  client: ApiClient,
  storeId: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<FinancePostingPageView> {
  const search = new URLSearchParams({ limit: String(PaginationLimits.DEFAULT) })
  if (cursor !== null) search.set('cursor', cursor)
  return client.request(withQuery(ApiRoutesFinance.postings, search), {
    schema: postingPageSchema,
    storeId,
    signal
  })
}

export async function retryFinancePosting(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<void> {
  await client.request(ApiRoutesFinance.postingRetry(encodeURIComponent(id)), {
    method: 'POST',
    schema: retrySchema,
    storeId
  })
}
