import {
  CodStatus,
  OrderReturnStatus,
  OrderStatus,
  PaymentStatus,
  ShipmentStatus
} from '@platform/core/domain'

// What stops the erasure of a customer: work of the store that still points to the person and that the store has to finish or the law keeps
// (TDD_05 §10.3). The statuses live here, in one place, so that the approval of a data request and any later reader count the same thing.
export const DsrOpenWorkStatuses = {
  // An order that is not delivered, cancelled or returned
  ORDERS: [
    OrderStatus.PENDING_CONFIRMATION,
    OrderStatus.CONFIRMED,
    OrderStatus.PREPARING,
    OrderStatus.SHIPPED
  ],
  // A delivered order whose payment was never settled is money the store still waits for
  UNPAID_ORDER: OrderStatus.DELIVERED,
  UNPAID_PAYMENT: PaymentStatus.PENDING,
  // A guide that is not at the end of its life
  SHIPMENTS_ENDED: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.RETURNED,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.FAILED
  ],
  RETURNS: [
    OrderReturnStatus.REQUESTED,
    OrderReturnStatus.APPROVED,
    OrderReturnStatus.IN_TRANSIT,
    OrderReturnStatus.RECEIVED
  ],
  // Cash on delivery the carrier collected, or has to, and has not settled with the store
  COD_OWED: [CodStatus.NOT_DELIVERED, CodStatus.PENDING_REMITTANCE, CodStatus.DISCREPANCY]
} as const

// Counts only, never an id or a value: they travel in the answer of a refused approval and in nothing else
export interface DsrOpenWork {
  orders: number
  shipments: number
  returns: number
  remittances: number
  receivables: number
}

export const hasOpenWork = (work: DsrOpenWork): boolean =>
  work.orders + work.shipments + work.returns + work.remittances + work.receivables > 0
