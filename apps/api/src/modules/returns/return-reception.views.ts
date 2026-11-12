import { type Permission, Permissions } from '@platform/core/auth'
import {
  type OrderReturnCondition,
  type ReceptionBatchStatus,
  ReceptionItemOutcome,
  type ReceptionScanResults,
  type ReceptionLine,
  type ShipmentKind,
  type ShipmentStatus
} from '@platform/core/domain'

// What the reception routes answer (TDD_17 §4.16). The customer appears only as "is it flagged" (the flag informs the team); the
// reason of a flag is a line about a person and is shown only to who may flag or read customers.

export const receptionItemSelect = {
  id: true,
  shipmentId: true,
  reason: true,
  condition: true,
  note: true,
  lines: true,
  flagCustomer: true,
  flagReason: true,
  confirmDelivered: true,
  outcome: true,
  errorCode: true,
  returnId: true,
  flagAppliedAt: true,
  scannedAt: true,
  shipment: {
    select: {
      guideNumber: true,
      status: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          customer: { select: { isCaution: true } },
          items: {
            select: { id: true, productName: true, variantName: true, quantity: true },
            orderBy: { id: 'asc' }
          }
        }
      }
    }
  }
} as const

// The shape the select above reads, written out: the Prisma namespace is not exported to the api
export interface ReceptionItemRow {
  id: string
  shipmentId: string
  reason: string
  condition: string
  note: string | null
  lines: unknown
  flagCustomer: boolean
  flagReason: string | null
  confirmDelivered: boolean
  outcome: string | null
  errorCode: string | null
  returnId: string | null
  flagAppliedAt: Date | null
  scannedAt: Date
  shipment: {
    guideNumber: string | null
    status: string
    order: {
      id: string
      orderNumber: string
      customer: { isCaution: boolean }
      items: { id: string; productName: string; variantName: string | null; quantity: number }[]
    }
  }
}

export interface ReceptionItemView {
  id: string
  shipmentId: string
  guideNumber: string | null
  shipmentStatus: ShipmentStatus
  orderId: string
  orderNumber: string
  // The units the package may hold: what the lines of the item are chosen from
  orderItems: { id: string; productName: string; variantName: string | null; quantity: number }[]
  customerIsCaution: boolean
  reason: string
  condition: OrderReturnCondition
  note: string | null
  // Empty: every unit of the order that is not in a return yet, in `condition`
  lines: ReceptionLine[]
  flagCustomer: boolean
  flagReason: string | null
  // The agent confirmed that a package whose guide is DELIVERED came back anyway
  confirmDelivered: boolean
  outcome: ReceptionItemOutcome | null
  errorCode: string | null
  returnId: string | null
  flagApplied: boolean
  scannedAt: string
}

export interface ReceptionCounts {
  total: number
  received: number
  failed: number
  pending: number
}

export interface ReceptionBatchView {
  id: string
  status: ReceptionBatchStatus
  createdBy: string
  createdAt: string
  completedAt: string | null
  counts: ReceptionCounts
  items: ReceptionItemView[]
}

export type ReceptionBatchSummaryView = Omit<ReceptionBatchView, 'items'>

// A code that more than one shipment answers to: the agent picks one and scans again naming it
export interface ReceptionCandidateView {
  shipmentId: string
  guideNumber: string | null
  orderNumber: string
  status: ShipmentStatus
  kind: ShipmentKind
}

export type ScanResultView =
  | { result: typeof ReceptionScanResults.ADDED; item: ReceptionItemView }
  | { result: typeof ReceptionScanResults.NOT_FOUND }
  | { result: typeof ReceptionScanResults.AMBIGUOUS; candidates: ReceptionCandidateView[] }
  // The guide is DELIVERED: the package is added only when the scan is sent again with `confirmDelivered`
  | { result: typeof ReceptionScanResults.NEEDS_CONFIRMATION; candidate: ReceptionCandidateView }

const mayReadFlagReason = (held: readonly Permission[]): boolean =>
  held.includes(Permissions.CUSTOMERS_FLAG_CAUTION) || held.includes(Permissions.CUSTOMERS_VIEW)

export function receptionItemView(
  row: ReceptionItemRow,
  held: readonly Permission[]
): ReceptionItemView {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    guideNumber: row.shipment.guideNumber,
    shipmentStatus: row.shipment.status as ShipmentStatus,
    orderId: row.shipment.order.id,
    orderNumber: row.shipment.order.orderNumber,
    orderItems: row.shipment.order.items,
    customerIsCaution: row.shipment.order.customer.isCaution,
    reason: row.reason,
    condition: row.condition as OrderReturnCondition,
    note: row.note,
    lines: row.lines as ReceptionLine[],
    flagCustomer: row.flagCustomer,
    flagReason: mayReadFlagReason(held) ? row.flagReason : null,
    confirmDelivered: row.confirmDelivered,
    outcome: row.outcome as ReceptionItemOutcome | null,
    errorCode: row.errorCode,
    returnId: row.returnId,
    flagApplied: row.flagAppliedAt !== null,
    scannedAt: row.scannedAt.toISOString()
  }
}

export function receptionCounts(items: readonly { outcome: string | null }[]): ReceptionCounts {
  const received = items.filter(item => item.outcome === ReceptionItemOutcome.RECEIVED).length
  const failed = items.filter(item => item.outcome === ReceptionItemOutcome.FAILED).length
  return { total: items.length, received, failed, pending: items.length - received - failed }
}
