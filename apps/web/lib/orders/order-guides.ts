import type { ShipmentSummaryView } from '@platform/api-client'
import { ShipmentInactiveStatuses, ShipmentKind } from '@platform/core/domain'

// Compared with the text the api answers: a state is text on the wire, not one of our enums
const OUTBOUND: string = ShipmentKind.OUTBOUND
const INACTIVE: ReadonlySet<string> = new Set(ShipmentInactiveStatuses)

// The guides that still hold their order: outbound and not cancelled, failed or returned. The newest comes first.
export function liveGuidesByOrder(
  shipments: readonly ShipmentSummaryView[]
): ReadonlyMap<string, ShipmentSummaryView[]> {
  const byOrder = new Map<string, ShipmentSummaryView[]>()
  for (const shipment of shipments) {
    if (shipment.kind !== OUTBOUND || INACTIVE.has(shipment.status)) continue
    byOrder.set(shipment.orderId, [...(byOrder.get(shipment.orderId) ?? []), shipment])
  }
  return byOrder
}
