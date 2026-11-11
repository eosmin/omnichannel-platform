import type { TransferShortageAction, TransferStatus } from '@platform/core/domain'

export interface TransferWarehouseView {
  id: string
  name: string
  code: string
}

// A line of the stores the caller belongs to (TDD_16 §1): no line of any other store is ever in an answer
export interface TransferLineView {
  id: string
  storeId: string
  productId: string
  productName: string
  variantId: string | null
  variantName: string | null
  sku: string | null
  quantity: number
  receivedQuantity: number
  pendingQuantity: number
  shortageAction: TransferShortageAction | null
}

export interface TransferSummaryView {
  id: string
  number: string
  status: TransferStatus
  fromWarehouse: TransferWarehouseView
  toWarehouse: TransferWarehouseView
  note: string | null
  createdBy: string
  dispatchedBy: string | null
  dispatchedAt: Date | null
  closedAt: Date | null
  createdAt: Date
  updatedAt: Date
  // Of the lines the caller sees, never of all of them
  lineCount: number
}

export interface TransferView extends Omit<TransferSummaryView, 'lineCount'> {
  lines: TransferLineView[]
}

export interface TransferPage {
  data: TransferSummaryView[]
  nextCursor: string | null
  hasMore: boolean
}

export const TRANSFER_SELECT = {
  id: true,
  number: true,
  status: true,
  note: true,
  createdBy: true,
  dispatchedBy: true,
  dispatchedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  fromWarehouse: { select: { id: true, name: true, code: true } },
  toWarehouse: { select: { id: true, name: true, code: true } }
} as const

export const LINE_SELECT = {
  id: true,
  storeId: true,
  productId: true,
  variantId: true,
  quantity: true,
  receivedQuantity: true,
  shortageAction: true,
  product: { select: { name: true, sku: true } },
  variant: { select: { name: true, sku: true } }
} as const

export interface TransferRow {
  id: string
  number: string
  status: string
  note: string | null
  createdBy: string
  dispatchedBy: string | null
  dispatchedAt: Date | null
  closedAt: Date | null
  createdAt: Date
  updatedAt: Date
  fromWarehouse: TransferWarehouseView
  toWarehouse: TransferWarehouseView
}

export interface TransferLineRow {
  id: string
  storeId: string
  productId: string
  variantId: string | null
  quantity: number
  receivedQuantity: number
  shortageAction: string | null
  product: { name: string; sku: string | null }
  variant: { name: string; sku: string | null } | null
}

function headerOf(row: TransferRow): Omit<TransferSummaryView, 'lineCount'> {
  return {
    id: row.id,
    number: row.number,
    // What the columns hold is written by the transfers service only, from the enums (and the database checks them)
    status: row.status as TransferStatus,
    fromWarehouse: row.fromWarehouse,
    toWarehouse: row.toWarehouse,
    note: row.note,
    createdBy: row.createdBy,
    dispatchedBy: row.dispatchedBy,
    dispatchedAt: row.dispatchedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export const transferSummaryView = (row: TransferRow, lineCount: number): TransferSummaryView => ({
  ...headerOf(row),
  lineCount
})

export function lineView(row: TransferLineRow): TransferLineView {
  return {
    id: row.id,
    storeId: row.storeId,
    productId: row.productId,
    productName: row.product.name,
    variantId: row.variantId,
    variantName: row.variant?.name ?? null,
    sku: row.variant?.sku ?? row.product.sku,
    quantity: row.quantity,
    receivedQuantity: row.receivedQuantity,
    pendingQuantity: row.quantity - row.receivedQuantity,
    shortageAction: row.shortageAction as TransferShortageAction | null
  }
}

export const transferView = (
  row: TransferRow,
  lines: readonly TransferLineRow[]
): TransferView => ({
  ...headerOf(row),
  lines: lines.map(lineView)
})
