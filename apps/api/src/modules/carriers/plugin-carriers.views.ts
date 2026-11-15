import type { CarrierConnectionView, CarrierRegistryEntry } from './carrier-connections.views'
import type {
  CarrierStatusCatalogEntry,
  UnmappedStatusView
} from './carrier-status-mappings.service'

// A carrier connection as a plugin reads it. Never in it, by name: whether credentials or a webhook secret exist, the address the
// carrier calls, the contact of the courier, the prefix of its guides, and the money agreed with the carrier (the fees, the
// commission, the rates by service, whether a remittance deducts the fee). The fields are named one by one, so a column added to the
// view of the screen does not reach a plugin until someone decides it should.
export type PluginCarrierConnectionView = Pick<
  CarrierConnectionView,
  | 'id'
  | 'carrierId'
  | 'carrierName'
  | 'displayName'
  | 'status'
  | 'capabilities'
  | 'isDefault'
  | 'defaultServiceCode'
  | 'defaultShippingPayer'
  | 'labelFormat'
  | 'services'
  | 'pickupEnabled'
  | 'pickupDays'
  | 'pickupCutoffTime'
  | 'autoPickup'
  | 'autoPickupTime'
  | 'pickupReminderMinutes'
  | 'pollIntervalMinutes'
  | 'maxDeliveryAttempts'
  | 'openShipments'
  | 'openPickups'
  | 'lastHealthyAt'
  | 'lastError'
  | 'createdAt'
  | 'updatedAt'
>

export function pluginCarrierConnection(view: CarrierConnectionView): PluginCarrierConnectionView {
  return {
    id: view.id,
    carrierId: view.carrierId,
    carrierName: view.carrierName,
    displayName: view.displayName,
    status: view.status,
    capabilities: view.capabilities,
    isDefault: view.isDefault,
    defaultServiceCode: view.defaultServiceCode,
    defaultShippingPayer: view.defaultShippingPayer,
    labelFormat: view.labelFormat,
    services: view.services,
    pickupEnabled: view.pickupEnabled,
    pickupDays: view.pickupDays,
    pickupCutoffTime: view.pickupCutoffTime,
    autoPickup: view.autoPickup,
    autoPickupTime: view.autoPickupTime,
    pickupReminderMinutes: view.pickupReminderMinutes,
    pollIntervalMinutes: view.pollIntervalMinutes,
    maxDeliveryAttempts: view.maxDeliveryAttempts,
    openShipments: view.openShipments,
    openPickups: view.openPickups,
    lastHealthyAt: view.lastHealthyAt,
    lastError: view.lastError,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt
  }
}

// The carriers of the catalog: what each can do and its services. Not the form that asks for its credentials (the names of the fields
// of a secret) nor the fees it declares.
export type PluginCarrierRegistryEntry = Pick<
  CarrierRegistryEntry,
  'id' | 'name' | 'version' | 'capabilities' | 'shipmentCreation' | 'maxBatchSize' | 'services'
>

export function pluginCarrierRegistryEntry(
  entry: CarrierRegistryEntry
): PluginCarrierRegistryEntry {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    capabilities: entry.capabilities,
    shipmentCreation: entry.shipmentCreation,
    maxBatchSize: entry.maxBatchSize,
    services: entry.services
  }
}

// What a carrier's statuses mean for this store, by name. The table that maps them is the owner's.
export type PluginStatusCatalogEntry = Pick<
  CarrierStatusCatalogEntry,
  'providerCode' | 'label' | 'defaultStatus' | 'hasMapping' | 'mappedStatus' | 'source'
>

export function pluginStatusCatalogEntry(
  entry: CarrierStatusCatalogEntry
): PluginStatusCatalogEntry {
  return {
    providerCode: entry.providerCode,
    label: entry.label,
    defaultStatus: entry.defaultStatus,
    hasMapping: entry.hasMapping,
    mappedStatus: entry.mappedStatus,
    source: entry.source
  }
}

// The statuses a carrier sent that nobody mapped yet: the code and how often, never `sampleRawStatus`, the text the carrier wrote
// (it can echo a recipient). A person reads it on the screen to decide the mapping.
export type PluginUnmappedStatusView = Omit<UnmappedStatusView, 'sampleRawStatus'>

export function pluginUnmappedStatus(view: UnmappedStatusView): PluginUnmappedStatusView {
  return {
    providerCode: view.providerCode,
    occurrences: view.occurrences,
    shipmentsWaiting: view.shipmentsWaiting,
    firstSeenAt: view.firstSeenAt,
    lastSeenAt: view.lastSeenAt
  }
}
