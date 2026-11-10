import type { CursorPage } from '@platform/core/domain'

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
      row.onHand > 0
        ? Number((2n * row.valueCents + BigInt(row.onHand)) / (2n * BigInt(row.onHand)))
        : null
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

export function movementView(row: MovementRow, canSeeCost: boolean): MovementView {
  const { unitCostCents, ...rest } = row
  return canSeeCost ? { ...rest, unitCostCents } : rest
}
