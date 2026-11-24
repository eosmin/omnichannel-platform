import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The warehouses of the organization of the store in X-Store-Id (TDD_16 §6). Reading asks for inventory:view;
// creating, changing and linking for org:manage_warehouses. A store link says where the warehouse stands in the
// list that store reserves from: priority 1 is reserved first.

const addressSchema = z.record(z.string(), z.string())
export type WarehouseAddress = z.output<typeof addressSchema>

const linkSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  priority: z.number().int()
})
export type WarehouseStoreLink = z.output<typeof linkSchema>

const warehouseDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  address: addressSchema.nullable(),
  active: z.boolean(),
  // In the order they are reserved from: the first priority first
  stores: z.array(linkSchema),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type WarehouseDetailView = z.output<typeof warehouseDetailSchema>

const warehousePageSchema = z.object({
  data: z.array(warehouseDetailSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type WarehousePageView = z.output<typeof warehousePageSchema>

// The address the api takes: two letters for the country, every field a line of text
export interface WarehouseAddressInput {
  line1: string
  line2?: string
  city: string
  state?: string
  postalCode?: string
  country?: string
}

export interface CreateWarehouseInput {
  name: string
  code: string
  address?: WarehouseAddressInput
}

// Only the keys that change; a null address clears it
export interface UpdateWarehouseInput {
  name?: string
  code?: string
  address?: WarehouseAddressInput | null
  active?: boolean
}

// The complete list of stores a warehouse serves: a store left out is unlinked. The priority is where the
// warehouse stands in that store's list.
export interface WarehouseStoreLinkInput {
  storeId: string
  priority?: number
}

export interface WarehouseListParams {
  active?: boolean
  cursor?: string | null
  limit?: number
}

export function fetchWarehousePage(
  client: ApiClient,
  storeId: string,
  params: WarehouseListParams = {},
  signal?: AbortSignal
): Promise<WarehousePageView> {
  const search = new URLSearchParams()
  if (params.active !== undefined) search.set('active', String(params.active))
  if (params.cursor !== undefined && params.cursor !== null) search.set('cursor', params.cursor)
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  const text = search.toString()
  return client.request(`${ApiRoutes.warehouses.list}${text === '' ? '' : `?${text}`}`, {
    schema: warehousePageSchema,
    storeId,
    signal
  })
}

// An organization holds at most 200 warehouses: the pages are followed up to the bound the api itself keeps, never
// further, so a cursor that never ends cannot loop
const MAX_PAGES = 20

export async function fetchAllWarehouses(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<WarehouseDetailView[]> {
  const found: WarehouseDetailView[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page: WarehousePageView = await fetchWarehousePage(
      client,
      storeId,
      { limit: PaginationLimits.MAX, cursor },
      signal
    )
    found.push(...page.data)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return found
}

export function createWarehouse(
  client: ApiClient,
  storeId: string,
  input: CreateWarehouseInput
): Promise<WarehouseDetailView> {
  return client.request(ApiRoutes.warehouses.create, {
    method: 'POST',
    body: input,
    schema: warehouseDetailSchema,
    storeId
  })
}

export function updateWarehouse(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateWarehouseInput
): Promise<WarehouseDetailView> {
  return client.request(ApiRoutes.warehouses.byId(encodeURIComponent(id)), {
    method: 'PATCH',
    body: input,
    schema: warehouseDetailSchema,
    storeId
  })
}

export function replaceWarehouseStores(
  client: ApiClient,
  storeId: string,
  id: string,
  stores: readonly WarehouseStoreLinkInput[]
): Promise<WarehouseDetailView> {
  return client.request(ApiRoutes.warehouses.stores(encodeURIComponent(id)), {
    method: 'PUT',
    body: { stores },
    schema: warehouseDetailSchema,
    storeId
  })
}
