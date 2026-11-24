import { z } from 'zod'

import { ApiRoutesSearch } from '@platform/core/api'
import {
  SearchApiParams,
  SearchEntities,
  type SearchEntity,
  type SearchTrackedScope
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the search routes answer (Step 5.1, TDD_08 §5). `snippet` is the customer's own text with the matches
// between the marks of `SearchSnippetMarks`: whoever draws it escapes everything else (never `innerHTML`).
// A name stays nullable: the hit carries the stored name only, and the screen says "Unnamed customer".
export const messageHitSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  type: z.string(),
  createdAt: z.string(),
  customerId: z.string(),
  customerName: z.string().nullable(),
  snippet: z.string()
})
export type MessageSearchHitView = z.output<typeof messageHitSchema>

export const customerHitSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable()
})
export type CustomerSearchHitView = z.output<typeof customerHitSchema>

// A state stays text so that a value of a newer server still draws; money is whole cents of the order currency
export const orderHitSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: z.string(),
  totalCents: z.number().int(),
  currency: z.string(),
  createdAt: z.string(),
  customerId: z.string(),
  customerName: z.string().nullable()
})
export type OrderSearchHitView = z.output<typeof orderHitSchema>

export const productHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  priceCents: z.number().int(),
  imageMediaId: z.string().nullable(),
  active: z.boolean(),
  matchedVariant: z
    .object({
      id: z.string(),
      name: z.string(),
      sku: z.string().nullable(),
      priceCents: z.number().int().nullable(),
      effectivePriceCents: z.number().int()
    })
    .nullable()
})
export type ProductSearchHitView = z.output<typeof productHitSchema>

const globalGroupSchema = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal(SearchEntities.MESSAGES), hits: z.array(messageHitSchema) }),
  z.object({ entity: z.literal(SearchEntities.CUSTOMERS), hits: z.array(customerHitSchema) }),
  z.object({ entity: z.literal(SearchEntities.ORDERS), hits: z.array(orderHitSchema) }),
  z.object({ entity: z.literal(SearchEntities.PRODUCTS), hits: z.array(productHitSchema) })
])
export type GlobalSearchGroupView = z.output<typeof globalGroupSchema>

const globalResultSchema = z.object({ query: z.string(), groups: z.array(globalGroupSchema) })
export type GlobalSearchView = z.output<typeof globalResultSchema>

function pageSchema<T extends z.ZodType>(hit: T) {
  return z.object({ query: z.string(), hits: z.array(hit), hasMore: z.boolean() })
}
const messagesPageSchema = pageSchema(messageHitSchema)
const customersPageSchema = pageSchema(customerHitSchema)
const ordersPageSchema = pageSchema(orderHitSchema)
// The products answer is the autocomplete of the catalog: `{ data }`, with no page
const productsPageSchema = z.object({ data: z.array(productHitSchema) })

export type MessageSearchPageView = z.output<typeof messagesPageSchema>
export type CustomerSearchPageView = z.output<typeof customersPageSchema>
export type OrderSearchPageView = z.output<typeof ordersPageSchema>
export type ProductSearchPageView = z.output<typeof productsPageSchema>

function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  return `?${query.toString()}`
}

// A few hits of each kind the member may search (the palette and the "all" tab of the results page). `passive` is the
// palette's as-you-type search: answered like any other, and not counted in the report of what was searched.
export function searchGlobal(
  client: ApiClient,
  storeId: string,
  q: string,
  signal?: AbortSignal,
  options: { passive?: boolean } = {}
): Promise<GlobalSearchView> {
  const params = { q, [SearchApiParams.PASSIVE]: options.passive === true ? 'true' : undefined }
  return client.request(`${ApiRoutesSearch.global}${queryString(params)}`, {
    schema: globalResultSchema,
    storeId,
    signal
  })
}

export function searchMessages(
  client: ApiClient,
  storeId: string,
  params: { q: string; limit?: number; conversationId?: string },
  signal?: AbortSignal
): Promise<MessageSearchPageView> {
  return client.request(`${ApiRoutesSearch.messages}${queryString(params)}`, {
    schema: messagesPageSchema,
    storeId,
    signal
  })
}

export function searchCustomers(
  client: ApiClient,
  storeId: string,
  params: { q: string; limit?: number },
  signal?: AbortSignal
): Promise<CustomerSearchPageView> {
  return client.request(`${ApiRoutesSearch.customers}${queryString(params)}`, {
    schema: customersPageSchema,
    storeId,
    signal
  })
}

export function searchOrders(
  client: ApiClient,
  storeId: string,
  params: { q: string; limit?: number },
  signal?: AbortSignal
): Promise<OrderSearchPageView> {
  return client.request(`${ApiRoutesSearch.orders}${queryString(params)}`, {
    schema: ordersPageSchema,
    storeId,
    signal
  })
}

export function searchCatalog(
  client: ApiClient,
  storeId: string,
  params: { q: string; limit?: number },
  signal?: AbortSignal
): Promise<ProductSearchPageView> {
  return client.request(`${ApiRoutesSearch.products}${queryString(params)}`, {
    schema: productsPageSchema,
    storeId,
    signal
  })
}

// The result a person opened, for the report of what was searched. It is never worth a wait or an error on the screen:
// whoever calls it does not await it, and a failure is a click that was not counted.
export interface SearchClick {
  // The text that was searched; the api hashes it and keeps nothing of it
  q: string
  // What the search was asked of, and the kind of thing that was opened
  scope: SearchTrackedScope
  entity: SearchEntity
  // The place of the result in the list the person saw (0 is the first)
  position: number
}

export function recordSearchClick(
  client: ApiClient,
  storeId: string,
  click: SearchClick
): Promise<undefined> {
  return client.request(ApiRoutesSearch.clicks, {
    method: 'POST',
    body: click,
    schema: z.undefined(),
    storeId
  })
}
