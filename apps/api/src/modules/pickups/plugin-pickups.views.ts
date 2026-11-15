import type { PickupManifest } from '@platform/core/shipping'

import type { PickupView } from './pickups.views'

// A pickup as a plugin reads it: the fields of the screen except `requestedBy`, the id of a person of the team (or 'system'). The
// fields are named one by one, so a column added to the view of the screen does not reach a plugin until someone decides it should.
export type PluginPickupView = Omit<PickupView, 'requestedBy'>

export function pluginPickupView(pickup: PickupView): PluginPickupView {
  return {
    id: pickup.id,
    connectionId: pickup.connectionId,
    connectionName: pickup.connectionName,
    carrierId: pickup.carrierId,
    pickupDate: pickup.pickupDate,
    status: pickup.status,
    packageCount: pickup.packageCount,
    revision: pickup.revision,
    providerPickupId: pickup.providerPickupId,
    windowStart: pickup.windowStart,
    windowEnd: pickup.windowEnd,
    lastError: pickup.lastError,
    createdAt: pickup.createdAt,
    updatedAt: pickup.updatedAt
  }
}

// The list the courier takes with them names the people the parcels go to: the route takes `customers:read` besides `pickups:read`,
// so a key that may not read customers reads no manifest. The lines are named one by one.
export function pluginPickupManifest(manifest: PickupManifest): PickupManifest {
  return {
    pickupId: manifest.pickupId,
    connectionName: manifest.connectionName,
    pickupDate: manifest.pickupDate,
    status: manifest.status,
    packageCount: manifest.packageCount,
    windowStart: manifest.windowStart,
    windowEnd: manifest.windowEnd,
    lines: manifest.lines.map(line => ({
      shipmentId: line.shipmentId,
      guideNumber: line.guideNumber,
      recipient: line.recipient,
      orderNumber: line.orderNumber,
      packageCount: line.packageCount
    }))
  }
}
