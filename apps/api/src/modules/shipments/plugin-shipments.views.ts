import type { CursorPage } from '@platform/core/domain'

import type { ShipmentDetailView, ShipmentView } from './shipments.views'

// A shipment as a plugin reads it: the fields of the screen except the money of the carrier (what it charges for the guide, what it
// is to remit and what it remitted, and the remittance that settled it) and `createdBy`, the id of a person of the team. The fields
// are named one by one, so a column added to the views of the screen does not reach a plugin until someone decides it should. The
// label is not here (only whether it exists): its link is a write-scope route, with the others, for PR E5-2.
export type PluginShipmentView = Omit<
  ShipmentView,
  'createdBy' | 'carrierCostCents' | 'codExpectedCents' | 'codRemittedCents' | 'codRemittanceId'
>
export type PluginShipmentDetailView = PluginShipmentView & {
  events: ShipmentDetailView['events']
}
export type PluginShipmentPage = CursorPage<PluginShipmentView>

export function pluginShipmentView(shipment: ShipmentView): PluginShipmentView {
  return {
    id: shipment.id,
    orderId: shipment.orderId,
    orderNumber: shipment.orderNumber,
    connectionId: shipment.connectionId,
    connectionName: shipment.connectionName,
    carrierId: shipment.carrierId,
    kind: shipment.kind,
    returnId: shipment.returnId,
    originWarehouseId: shipment.originWarehouseId,
    status: shipment.status,
    serviceCode: shipment.serviceCode,
    shippingPayer: shipment.shippingPayer,
    codAmountCents: shipment.codAmountCents,
    codStatus: shipment.codStatus,
    deliveredAt: shipment.deliveredAt,
    currency: shipment.currency,
    packageCount: shipment.packageCount,
    failedAttempts: shipment.failedAttempts,
    guideNumber: shipment.guideNumber,
    trackingUrl: shipment.trackingUrl,
    hasLabel: shipment.hasLabel,
    refundStatus: shipment.refundStatus,
    pickupId: shipment.pickupId,
    lastError: shipment.lastError,
    cancelRequestedAt: shipment.cancelRequestedAt,
    cancelledAt: shipment.cancelledAt,
    createdAt: shipment.createdAt,
    updatedAt: shipment.updatedAt
  }
}

export function pluginShipmentDetail(shipment: ShipmentDetailView): PluginShipmentDetailView {
  return {
    ...pluginShipmentView(shipment),
    events: shipment.events.map(event => ({
      id: event.id,
      status: event.status,
      rawStatus: event.rawStatus,
      description: event.description,
      occurredAt: event.occurredAt,
      source: event.source
    }))
  }
}

export function pluginShipmentPage(page: CursorPage<ShipmentView>): PluginShipmentPage {
  return { ...page, data: page.data.map(pluginShipmentView) }
}
