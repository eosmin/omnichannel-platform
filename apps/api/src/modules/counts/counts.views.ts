import type { CountStatus } from '@platform/core/domain'

import { varianceOf } from './counts.rules'

export interface CountTotalsView {
  // Only the lines of the stores the caller belongs to (TDD_16 §1)
  lines: number
  counted: number
  withVariance: number
}

export interface CountView {
  id: string
  number: string
  status: CountStatus
  warehouse: { id: string; name: string; code: string }
  // The store the count is limited to; null: every store that keeps stock in the warehouse
  storeId: string | null
  storeName: string | null
  note: string | null
  createdBy: string
  startedAt: Date | null
  submittedAt: Date | null
  appliedBy: string | null
  appliedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface CountDetailView extends CountView {
  totals: CountTotalsView
  lines: CountLineView[]
  nextCursor: string | null
  hasMore: boolean
}

export interface CountLineView {
  id: string
  storeId: string
  productId: string
  productName: string
  sku: string | null
  variantId: string | null
  variantName: string | null
  expectedQuantity: number
  countedQuantity: number | null
  // Counted minus the snapshot; null until counted
  variance: number | null
}

export interface CountPage {
  data: CountView[]
  nextCursor: string | null
  hasMore: boolean
}

export const COUNT_SELECT = {
  id: true,
  number: true,
  status: true,
  storeId: true,
  note: true,
  createdBy: true,
  startedAt: true,
  submittedAt: true,
  appliedBy: true,
  appliedAt: true,
  createdAt: true,
  updatedAt: true,
  warehouse: { select: { id: true, name: true, code: true } }
} as const

export const COUNT_LINE_SELECT = {
  id: true,
  storeId: true,
  productId: true,
  variantId: true,
  expectedQuantity: true,
  countedQuantity: true,
  product: { select: { name: true, sku: true } },
  variant: { select: { name: true, sku: true } }
} as const

interface CountRow {
  id: string
  number: string
  status: string
  storeId: string | null
  note: string | null
  createdBy: string
  startedAt: Date | null
  submittedAt: Date | null
  appliedBy: string | null
  appliedAt: Date | null
  createdAt: Date
  updatedAt: Date
  warehouse: { id: string; name: string; code: string }
}

export function countView(row: CountRow, storeName: string | null): CountView {
  return {
    id: row.id,
    number: row.number,
    status: row.status as CountStatus,
    warehouse: row.warehouse,
    storeId: row.storeId,
    storeName,
    note: row.note,
    createdBy: row.createdBy,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    appliedBy: row.appliedBy,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

interface LineRow {
  id: string
  storeId: string
  productId: string
  variantId: string | null
  expectedQuantity: number
  countedQuantity: number | null
  product: { name: string; sku: string | null }
  variant: { name: string; sku: string | null } | null
}

export function countLineView(row: LineRow): CountLineView {
  return {
    id: row.id,
    storeId: row.storeId,
    productId: row.productId,
    productName: row.product.name,
    // The sku of the variant is the one that is sold; the product's is the fallback
    sku: row.variant?.sku ?? row.product.sku,
    variantId: row.variantId,
    variantName: row.variant?.name ?? null,
    expectedQuantity: row.expectedQuantity,
    countedQuantity: row.countedQuantity,
    variance: varianceOf(row)
  }
}
