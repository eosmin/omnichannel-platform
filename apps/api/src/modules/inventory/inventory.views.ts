import type { CursorPage } from '@platform/core/domain'
import { roundedDivision } from '@platform/core/inventory'

// What stock looks like to the api (TDD_16 §6). The cost fields (`valueCents`, `averageCostCents`, `unitCostCents`)
// are there only for a caller who holds products:view_cost: for the others the keys are absent.

export interface LevelView {
  id: string
  productId: string
  productName: string
  productSku: string | null
  variantId: string | null
  variantName: string | null
  variantSku: string | null
  warehouseId: string
  warehouseCode: string
  warehouseName: string
  onHand: number
  reserved: number
  // onHand - reserved: negative when the store sells beyond its stock (shown as "oversold")
  available: number
  // Null: no alert for this product
  lowStockThreshold: number | null
  // What the units on hand are worth at their cost (weighted average), and that cost per unit (null with none on hand)
  valueCents?: number
  averageCostCents?: number | null
  updatedAt: Date
}

export interface MovementView {
  id: string
  productId: string
  variantId: string | null
  warehouseId: string
  type: string
  quantity: number
  reason: string | null
  note: string | null
  referenceType: string | null
  referenceId: string | null
  onHandAfter: number
  reservedAfter: number
  unitCostCents?: number | null
  createdBy: string | null
  createdAt: Date
}

export type LevelPage = CursorPage<LevelView>
export type MovementPage = CursorPage<MovementView>

// The levels of one product, one row per item and warehouse
export interface ProductInventory {
  productId: string
  trackInventory: boolean
  lowStockThreshold: number | null
  onHand: number
  reserved: number
  available: number
  levels: LevelView[]
}

// The answer of an adjustment: the movement it made, and whether it was a retry of one already made
export interface AdjustmentView {
  movement: MovementView
  replayed: boolean
}

interface LevelRow {
  id: string
  productId: string
  variantId: string | null
  warehouseId: string
  onHand: number
  reserved: number
  valueCents: bigint
  updatedAt: Date
  product: { name: string; sku: string | null; lowStockThreshold: number | null }
  variant: { name: string; sku: string | null } | null
  warehouse: { code: string; name: string }
}

export const LEVEL_SELECT = {
  id: true,
  productId: true,
  variantId: true,
  warehouseId: true,
  onHand: true,
  reserved: true,
  valueCents: true,
  updatedAt: true,
  product: { select: { name: true, sku: true, lowStockThreshold: true } },
  variant: { select: { name: true, sku: true } },
  warehouse: { select: { code: true, name: true } }
} as const

export function levelView(row: LevelRow, canSeeCost: boolean): LevelView {
  const view: LevelView = {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    productSku: row.product.sku,
    variantId: row.variantId,
    variantName: row.variant?.name ?? null,
    variantSku: row.variant?.sku ?? null,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    warehouseName: row.warehouse.name,
    onHand: row.onHand,
    reserved: row.reserved,
    available: row.onHand - row.reserved,
    lowStockThreshold: row.product.lowStockThreshold,
    updatedAt: row.updatedAt
  }
  if (!canSeeCost) return view
  return {
    ...view,
    valueCents: Number(row.valueCents),
    averageCostCents:
      row.onHand > 0 ? Number(roundedDivision(row.valueCents, BigInt(row.onHand))) : null
  }
}

interface MovementRow {
  id: string
  productId: string
  variantId: string | null
  warehouseId: string
  type: string
  quantity: number
  reason: string | null
  note: string | null
  referenceType: string | null
  referenceId: string | null
  onHandAfter: number
  reservedAfter: number
  unitCostCents: number | null
  createdBy: string | null
  createdAt: Date
}

export const MOVEMENT_SELECT = {
  id: true,
  seq: true,
  productId: true,
  variantId: true,
  warehouseId: true,
  type: true,
  quantity: true,
  reason: true,
  note: true,
  referenceType: true,
  referenceId: true,
  onHandAfter: true,
  reservedAfter: true,
  unitCostCents: true,
  createdBy: true,
  createdAt: true
} as const

// The fields are named one by one: whatever else a row carries (the key, the store) never reaches the answer, and a
// new column cannot get round the cost rule by being spread in
export function movementView(row: MovementRow, canSeeCost: boolean): MovementView {
  const view: MovementView = {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    warehouseId: row.warehouseId,
    type: row.type,
    quantity: row.quantity,
    reason: row.reason,
    note: row.note,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    onHandAfter: row.onHandAfter,
    reservedAfter: row.reservedAfter,
    createdBy: row.createdBy,
    createdAt: row.createdAt
  }
  return canSeeCost ? { ...view, unitCostCents: row.unitCostCents } : view
}

// The available stock of one product of the store (all its items, all the warehouses), for the catalog list
export interface StockSummaryRow {
  productId: string
  trackInventory: boolean
  onHand: number
  reserved: number
  available: number
  // Null: no alert for this product
  lowStockThreshold: number | null
  // The product tracks stock, has a threshold and its available stock is at or under it (TDD_16 §4.4)
  isLow: boolean
}

export interface StockSummary {
  data: StockSummaryRow[]
}
