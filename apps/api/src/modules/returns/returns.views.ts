import type {
  OrderReturnCondition,
  OrderReturnStatus,
  OrderReturnType
} from '@platform/core/domain'

// What the api says of a return (TDD_17 §2, §6). No address, phone or guide secret: ids, quantities, statuses and the team's note.
export const RETURN_SELECT = {
  id: true,
  orderId: true,
  type: true,
  reason: true,
  status: true,
  shippingPayer: true,
  replacementOrderId: true,
  returnShipmentId: true,
  refundAmountCents: true,
  notes: true,
  createdBy: true,
  createdAt: true,
  receivedAt: true,
  order: { select: { orderNumber: true } },
  lines: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      orderItemId: true,
      quantity: true,
      condition: true,
      restockWarehouseId: true,
      orderItem: { select: { productName: true, variantName: true } }
    }
  }
} as const

export interface ReturnRow {
  id: string
  orderId: string
  type: string
  reason: string
  status: string
  shippingPayer: string
  replacementOrderId: string | null
  returnShipmentId: string | null
  refundAmountCents: number | null
  notes: string | null
  createdBy: string
  createdAt: Date
  receivedAt: Date | null
  order: { orderNumber: string }
  lines: {
    id: string
    orderItemId: string
    quantity: number
    condition: string | null
    restockWarehouseId: string | null
    orderItem: { productName: string; variantName: string | null }
  }[]
}

export interface ReturnLineView {
  id: string
  orderItemId: string
  productName: string
  variantName: string | null
  quantity: number
  condition: OrderReturnCondition | null
  restockWarehouseId: string | null
}

export interface ReturnView {
  id: string
  orderId: string
  orderNumber: string
  type: OrderReturnType
  reason: string
  status: OrderReturnStatus
  shippingPayer: string
  replacementOrderId: string | null
  returnShipmentId: string | null
  refundAmountCents: number | null
  notes: string | null
  createdBy: string
  createdAt: string
  receivedAt: string | null
  lines: ReturnLineView[]
}

export function returnViewOf(row: ReturnRow): ReturnView {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    type: row.type as OrderReturnType,
    reason: row.reason,
    status: row.status as OrderReturnStatus,
    shippingPayer: row.shippingPayer,
    replacementOrderId: row.replacementOrderId,
    returnShipmentId: row.returnShipmentId,
    refundAmountCents: row.refundAmountCents,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    receivedAt: row.receivedAt === null ? null : row.receivedAt.toISOString(),
    lines: row.lines.map(line => ({
      id: line.id,
      orderItemId: line.orderItemId,
      productName: line.orderItem.productName,
      variantName: line.orderItem.variantName,
      quantity: line.quantity,
      condition: line.condition as OrderReturnCondition | null,
      restockWarehouseId: line.restockWarehouseId
    }))
  }
}
