import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import {
  CountLimits,
  type CountLineFilter,
  CountStatus,
  PaginationLimits
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the count routes answer (TDD_16 §4.6, §6). Quantities are whole units. A count belongs to the organization; the
// api reads it from X-Store-Id, so every call goes through a store of the person. The lines and totals of a count are
// only those of the stores the person belongs to.
const countSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(CountStatus),
  warehouse: z.object({ id: z.string(), name: z.string(), code: z.string() }),
  // The store the count is limited to; null: every store that keeps stock in the warehouse
  storeId: z.string().nullable(),
  storeName: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string(),
  startedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  appliedBy: z.string().nullable(),
  appliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type CountView = z.output<typeof countSchema>

const countPageSchema = z.object({
  data: z.array(countSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type CountPageView = z.output<typeof countPageSchema>

const countLineSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  productId: z.string(),
  productName: z.string(),
  sku: z.string().nullable(),
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  expectedQuantity: z.number().int(),
  // Null until counted: "not counted" is not "zero"
  countedQuantity: z.number().int().nullable(),
  // Counted minus the snapshot; null until counted
  variance: z.number().int().nullable()
})
export type CountLineView = z.output<typeof countLineSchema>

const countDetailSchema = countSchema.extend({
  totals: z.object({
    lines: z.number().int(),
    counted: z.number().int(),
    withVariance: z.number().int()
  }),
  lines: z.array(countLineSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type CountDetailView = z.output<typeof countDetailSchema>

// The warehouses a count may be made in: every active warehouse of the organization, not only those a store of the
// person is linked to
const warehouseOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  active: z.boolean()
})
export type CountWarehouseOption = z.output<typeof warehouseOptionSchema>

const warehouseOptionPageSchema = z.object({
  data: z.array(warehouseOptionSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})

export interface ListCountsParams {
  cursor?: string | null
  limit?: number
  status?: CountStatus
  warehouseId?: string
}

export interface CountLinesParams {
  cursor?: string | null
  limit?: number
  // Only the lines still to count, or only those whose count differs from the snapshot
  filter?: CountLineFilter
}

export interface CreateCountInput {
  warehouseId: string
  // Limits the count to the products of one store where the person may count
  storeId?: string
  note?: string
}

export interface CountLineEntry {
  lineId: string
  // Null takes a quantity back (not counted)
  countedQuantity: number | null
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export function fetchCounts(
  client: ApiClient,
  storeId: string,
  params: ListCountsParams = {},
  signal?: AbortSignal
): Promise<CountPageView> {
  const search = query({
    cursor: params.cursor ?? undefined,
    limit: params.limit === undefined ? undefined : String(params.limit),
    status: params.status,
    warehouseId: params.warehouseId
  })
  return client.request(`${ApiRoutes.counts.list}${search}`, {
    schema: countPageSchema,
    storeId,
    signal
  })
}

// One page of the lines of a count, in the order of the api (by id): the screens that need another order sort what
// they hold
export function fetchCount(
  client: ApiClient,
  storeId: string,
  countId: string,
  params: CountLinesParams = {},
  signal?: AbortSignal
): Promise<CountDetailView> {
  const search = query({
    cursor: params.cursor ?? undefined,
    limit: params.limit === undefined ? undefined : String(params.limit),
    filter: params.filter
  })
  return client.request(`${ApiRoutes.counts.byId(countId)}${search}`, {
    schema: countDetailSchema,
    storeId,
    signal
  })
}

// A count holds at most CountLimits.MAX_LINES lines, so every page of it is read: the count screen searches, sorts and
// totals what it holds. The header and the totals are those of the first page; the loop is bounded by the limit of
// lines, never by a cursor that might not end.
export async function fetchAllCountLines(
  client: ApiClient,
  storeId: string,
  countId: string,
  filter?: CountLineFilter,
  signal?: AbortSignal
): Promise<CountDetailView> {
  const maxPages = Math.ceil(CountLimits.MAX_LINES / PaginationLimits.MAX) + 1
  let first: CountDetailView | null = null
  const lines: CountLineView[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < maxPages; pages += 1) {
    const page: CountDetailView = await fetchCount(
      client,
      storeId,
      countId,
      { cursor, limit: PaginationLimits.MAX, filter },
      signal
    )
    first ??= page
    lines.push(...page.lines)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  if (first === null) throw new Error('a count has at least one page')
  return { ...first, lines, nextCursor: null, hasMore: false }
}

export function createCount(
  client: ApiClient,
  storeId: string,
  input: CreateCountInput
): Promise<CountView> {
  return client.request(ApiRoutes.counts.create, {
    method: 'POST',
    body: input,
    schema: countSchema,
    storeId
  })
}

function transition(
  route: (id: string) => string
): (client: ApiClient, storeId: string, countId: string) => Promise<CountView> {
  return (client, storeId, countId) =>
    client.request(route(countId), { method: 'POST', schema: countSchema, storeId })
}

// Draft → counting: the api makes the lines from the levels of the warehouse and snapshots what each holds
export const startCount = transition(ApiRoutes.counts.start)
// Counting → review: the approvers are told
export const submitCount = transition(ApiRoutes.counts.submit)
// Review → counting: the approver asks for a recount
export const reopenCount = transition(ApiRoutes.counts.reopen)
// Review → applied: the variance of each counted line becomes a stock movement, all or none
export const applyCount = transition(ApiRoutes.counts.apply)
export const cancelCount = transition(ApiRoutes.counts.cancel)

// The quantities staff typed, a few rows at a time (counting only)
export function updateCountLines(
  client: ApiClient,
  storeId: string,
  countId: string,
  lines: readonly CountLineEntry[]
): Promise<CountView> {
  return client.request(ApiRoutes.counts.lines(countId), {
    method: 'PATCH',
    body: { lines },
    schema: countSchema,
    storeId
  })
}

// More pages than a warehouse list has: the loop stops here rather than follow a cursor that never ends
const MAX_WAREHOUSE_PAGES = 20

export async function fetchCountWarehouses(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<CountWarehouseOption[]> {
  const found: CountWarehouseOption[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < MAX_WAREHOUSE_PAGES; pages += 1) {
    const page: z.output<typeof warehouseOptionPageSchema> = await client.request(
      `${ApiRoutes.warehouses.list}${query({
        limit: String(PaginationLimits.MAX),
        active: 'true',
        cursor: cursor ?? undefined
      })}`,
      { schema: warehouseOptionPageSchema, storeId, signal }
    )
    found.push(...page.data)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return found
}
