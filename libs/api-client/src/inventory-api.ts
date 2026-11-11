import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import {
  type InventoryLevelSort,
  type InventoryMovementType,
  PaginationLimits
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the stock routes answer (TDD_16 §6). Quantities are whole units; money is whole USD cents. The cost keys
// (`valueCents`, `averageCostCents`, `unitCostCents`) are there only for a caller who holds products:view_cost: for
// the others they are absent, and the screens leave the columns out (absent is not "no cost").
const levelSchema = z.object({
  id: z.string(),
  productId: z.string(),
  productName: z.string(),
  productSku: z.string().nullable(),
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  variantSku: z.string().nullable(),
  warehouseId: z.string(),
  warehouseCode: z.string(),
  warehouseName: z.string(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  // onHand - reserved: negative when the store sells beyond its stock ("oversold")
  available: z.number().int(),
  lowStockThreshold: z.number().int().nullable(),
  valueCents: z.number().int().optional(),
  averageCostCents: z.number().int().nullable().optional(),
  updatedAt: z.string()
})
export type StockLevelView = z.output<typeof levelSchema>

const levelPageSchema = z.object({
  data: z.array(levelSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type StockLevelPageView = z.output<typeof levelPageSchema>

// What the stock screen of the store asks of GET /inventory/levels: every key is a query key of the api
export interface StockLevelFilter {
  q?: string
  lowStock?: boolean
  warehouseId?: string
  sort?: InventoryLevelSort
}

const productInventorySchema = z.object({
  productId: z.string(),
  trackInventory: z.boolean(),
  lowStockThreshold: z.number().int().nullable(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  levels: z.array(levelSchema)
})
export type ProductInventoryView = z.output<typeof productInventorySchema>

const movementSchema = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  warehouseId: z.string(),
  type: z.string(),
  quantity: z.number().int(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  onHandAfter: z.number().int(),
  reservedAfter: z.number().int(),
  unitCostCents: z.number().int().nullable().optional(),
  createdBy: z.string().nullable(),
  createdAt: z.string()
})
export type StockMovementView = z.output<typeof movementSchema>

const movementPageSchema = z.object({
  data: z.array(movementSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type StockMovementPageView = z.output<typeof movementPageSchema>

const adjustmentSchema = z.object({ movement: movementSchema, replayed: z.boolean() })
export type StockAdjustmentView = z.output<typeof adjustmentSchema>

// The warehouses of the organization, with the stores each one serves (GET /warehouses)
const warehouseSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  active: z.boolean(),
  stores: z.array(
    z.object({ storeId: z.string(), storeName: z.string(), priority: z.number().int() })
  )
})
export type WarehouseView = z.output<typeof warehouseSchema>

const warehousePageSchema = z.object({
  data: z.array(warehouseSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})

// POST /inventory/adjustments. `idempotencyKey` is made once per attempt by the caller (a UUID): a double click or a
// retry adjusts once. `reason` is required for an adjustment; a receipt takes a reason or a note.
export interface StockAdjustmentInput {
  warehouseId: string
  productId: string
  variantId?: string
  type:
    | InventoryMovementType.RECEIPT
    | InventoryMovementType.ADJUSTMENT_IN
    | InventoryMovementType.ADJUSTMENT_OUT
  quantity: number
  reason?: string
  note?: string
  idempotencyKey: string
  // The cost of ONE unit that comes in, in whole USD cents: setting it needs products:view_cost
  unitCostCents?: number
}

export interface KardexParams {
  productId: string
  variantId?: string | null
  warehouseId: string
  cursor?: string | null
  limit?: number
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export function fetchProductInventory(
  client: ApiClient,
  storeId: string,
  productId: string,
  signal?: AbortSignal
): Promise<ProductInventoryView> {
  return client.request(ApiRoutes.products.inventory(productId), {
    schema: productInventorySchema,
    storeId,
    signal
  })
}

// Every level of the store, a page at a time (the stock screen). The cursor belongs to the sort that made it.
export function fetchStockLevels(
  client: ApiClient,
  storeId: string,
  params: StockLevelFilter & { cursor?: string | null; limit?: number },
  signal?: AbortSignal
): Promise<StockLevelPageView> {
  const search = query({
    q: params.q === undefined || params.q.trim() === '' ? undefined : params.q.trim(),
    lowStock: params.lowStock === undefined ? undefined : String(params.lowStock),
    warehouseId: params.warehouseId,
    sort: params.sort,
    cursor: params.cursor ?? undefined,
    limit: params.limit === undefined ? undefined : String(params.limit)
  })
  return client.request(`${ApiRoutes.inventory.levels}${search}`, {
    schema: levelPageSchema,
    storeId,
    signal
  })
}

// One item in one warehouse, newest first: each row says what was on hand after it
export function fetchKardex(
  client: ApiClient,
  storeId: string,
  params: KardexParams,
  signal?: AbortSignal
): Promise<StockMovementPageView> {
  const search = query({
    productId: params.productId,
    variantId: params.variantId ?? undefined,
    warehouseId: params.warehouseId,
    cursor: params.cursor ?? undefined,
    limit: params.limit === undefined ? undefined : String(params.limit)
  })
  return client.request(`${ApiRoutes.inventory.kardex}${search}`, {
    schema: movementPageSchema,
    storeId,
    signal
  })
}

export function createStockAdjustment(
  client: ApiClient,
  storeId: string,
  input: StockAdjustmentInput
): Promise<StockAdjustmentView> {
  return client.request(ApiRoutes.inventory.adjustments, {
    method: 'POST',
    body: input,
    schema: adjustmentSchema,
    storeId
  })
}

// The active warehouses of the organization the store sells from (the adjustment names one of them): every page of
// them is read, since the ones of this store may be on any
export async function fetchWarehousesOfStore(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<WarehouseView[]> {
  const found: WarehouseView[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < MAX_WAREHOUSE_PAGES; pages += 1) {
    const page: z.output<typeof warehousePageSchema> = await client.request(
      `${ApiRoutes.warehouses.list}${query({
        limit: String(PaginationLimits.MAX),
        active: 'true',
        cursor: cursor ?? undefined
      })}`,
      { schema: warehousePageSchema, storeId, signal }
    )
    found.push(...page.data)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return found.filter(warehouse => warehouse.stores.some(link => link.storeId === storeId))
}

// More pages than a store has warehouses for: the loop stops here rather than follow a cursor that never ends
const MAX_WAREHOUSE_PAGES = 20
