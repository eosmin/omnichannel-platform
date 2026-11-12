import type { ShipmentStatus } from '@platform/core/domain'

// What the api says of a shipment (TDD_17 §2, §6). The address, the phones and the guide's cost stay out of an event but
// the screens of the shipping team read them here: `SHIPPING_VIEW` is the permission of the route.
export const SHIPMENT_SELECT = {
  id: true,
  orderId: true,
  connectionId: true,
  kind: true,
  returnId: true,
  originWarehouseId: true,
  status: true,
  serviceCode: true,
  shippingPayer: true,
  codAmountCents: true,
  codStatus: true,
  codExpectedCents: true,
  codRemittedCents: true,
  codRemittanceId: true,
  deliveredAt: true,
  currency: true,
  packageCount: true,
  failedAttempts: true,
  guideNumber: true,
  trackingUrl: true,
  labelMediaId: true,
  carrierCostCents: true,
  refundStatus: true,
  pickupId: true,
  lastError: true,
  cancelRequestedAt: true,
  cancelledAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  order: { select: { orderNumber: true } },
  connection: { select: { displayName: true, carrierId: true } }
} as const

export interface ShipmentRow {
  id: string
  orderId: string
  connectionId: string
  kind: string
  returnId: string | null
  originWarehouseId: string | null
  status: string
  serviceCode: string
  shippingPayer: string
  codAmountCents: number | null
  codStatus: string
  codExpectedCents: number | null
  codRemittedCents: number | null
  codRemittanceId: string | null
  deliveredAt: Date | null
  currency: string
  packageCount: number
  failedAttempts: number
  guideNumber: string | null
  trackingUrl: string | null
  labelMediaId: string | null
  carrierCostCents: number | null
  refundStatus: string
  pickupId: string | null
  lastError: string | null
  cancelRequestedAt: Date | null
  cancelledAt: Date | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  order: { orderNumber: string }
  connection: { displayName: string; carrierId: string }
}

export interface ShipmentView {
  id: string
  orderId: string
  orderNumber: string
  connectionId: string
  connectionName: string
  carrierId: string
  kind: string
  returnId: string | null
  originWarehouseId: string | null
  status: ShipmentStatus
  serviceCode: string
  shippingPayer: string
  codAmountCents: number | null
  codStatus: string
  // What the carrier is to remit for it (written when it is delivered), what it remitted and the remittance that settled it (§4.15)
  codExpectedCents: number | null
  codRemittedCents: number | null
  codRemittanceId: string | null
  deliveredAt: string | null
  currency: string
  packageCount: number
  failedAttempts: number
  guideNumber: string | null
  trackingUrl: string | null
  // The label is stored once and printed from there; whether it is ready to print is the label route's answer
  hasLabel: boolean
  carrierCostCents: number | null
  refundStatus: string
  pickupId: string | null
  // A name of a closed list, or one line the carrier said when it refused
  lastError: string | null
  cancelRequestedAt: string | null
  cancelledAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export function shipmentViewOf(row: ShipmentRow): ShipmentView {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    connectionId: row.connectionId,
    connectionName: row.connection.displayName,
    carrierId: row.connection.carrierId,
    kind: row.kind,
    returnId: row.returnId,
    originWarehouseId: row.originWarehouseId,
    status: row.status as ShipmentStatus,
    serviceCode: row.serviceCode,
    shippingPayer: row.shippingPayer,
    codAmountCents: row.codAmountCents,
    codStatus: row.codStatus,
    codExpectedCents: row.codExpectedCents,
    codRemittedCents: row.codRemittedCents,
    codRemittanceId: row.codRemittanceId,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    currency: row.currency,
    packageCount: row.packageCount,
    failedAttempts: row.failedAttempts,
    guideNumber: row.guideNumber,
    trackingUrl: row.trackingUrl,
    hasLabel: row.labelMediaId !== null,
    carrierCostCents: row.carrierCostCents,
    refundStatus: row.refundStatus,
    pickupId: row.pickupId,
    lastError: row.lastError,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

export interface ShipmentEventView {
  id: string
  status: string | null
  rawStatus: string | null
  description: string | null
  occurredAt: string
  source: string
}

export interface ShipmentDetailView extends ShipmentView {
  events: ShipmentEventView[]
}

export interface LabelLinkView {
  url: string
  filename: string
}

export interface CheckResultView {
  found: boolean
  shipment: ShipmentView
}
