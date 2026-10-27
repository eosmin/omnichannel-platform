import type { LabelFormatType, ShipmentStatus, ShippingPayer } from '@platform/core/domain'

// The contract of a carrier plugin. The fields TDD_17 names are here; the ones it leaves to the carrier
// documents (a pickup's details, a location's ids) are the smallest shape the core needs and
// Step 4.8 refines them against the real APIs.

export interface CarrierServiceDescriptor {
  code: string // the carrier's own code
  label: string
  defaultForNextDay?: boolean
}

export interface CarrierStatusDescriptor {
  code: string // the carrier's own status code
  label: string
  // What we assume the code means; null when it is not safe to assume
  defaultStatus: ShipmentStatus | null
}

export interface CarrierContext {
  storeId: string
  connectionId: string
  // Decrypted by the core for this call only
  credentials: Record<string, unknown>
  metadata: Record<string, unknown>
}

export interface CarrierConnectInput {
  storeId: string
  credentials: Record<string, unknown>
}

export interface CarrierConnectResult {
  displayName: string
  credentials: Record<string, unknown>
  metadata: Record<string, unknown>
}

export interface CarrierHealth {
  healthy: boolean
  checkedAt: string
  error?: string
}

export interface CarrierAddress {
  line1: string
  line2?: string
  city: string
  region?: string
  postalCode?: string
  country: string
}

export interface CarrierParcel {
  weightGrams?: number
  lengthCm?: number
  widthCm?: number
  heightCm?: number
}

export interface CarrierLocationIds {
  departmentId: string
  municipalityId: string
  settlementId?: string
}

export interface CreateShipmentParams {
  reference: string // the order number
  idempotencyKey: string
  sender: { name: string; address: CarrierAddress; phone: string }
  recipient: {
    name: string
    // National digits only, no country code; the first is the main one
    phones: readonly string[]
    address: CarrierAddress
    // Present when the plugin declares REQUIRES_LOCATION_IDS
    locationIds?: CarrierLocationIds
  }
  packageCount: number
  parcels: readonly CarrierParcel[]
  serviceCode: string
  shippingPayer: ShippingPayer
  cod: { amountCents: number; currency: string } | null
  labelFormat: LabelFormatType
}

export interface CarrierLabel {
  format: LabelFormatType
  contentType: string
  data: Uint8Array
}

export interface CreateShipmentResult {
  guideNumber: string
  providerShipmentId?: string
  label?: CarrierLabel // absent when fetchLabel is needed
}

export interface PickupWindow {
  date: string // ISO date
  from: string // HH:mm
  to: string // HH:mm
}

export interface CreatePickupBatchParams {
  idempotencyKey: string
  pickup: { window: PickupWindow; packageCount: number }
  shipments: readonly CreateShipmentParams[]
}

export interface PickupBatchResult {
  pickupRef: string
  // One entry per shipment of the batch, in the same order
  shipments: readonly CreateShipmentResult[]
}

export interface PickupRef {
  pickupRef: string
}

export interface PickupDetails extends PickupRef {
  shipments: readonly CreateShipmentResult[]
}

export interface PickupParams {
  idempotencyKey: string
  window: PickupWindow
  packageCount: number
}

export interface ModifyPickupParams extends PickupRef {
  packageCount: number
}

export interface CancelPickupParams extends PickupRef {
  reason?: string
}

export interface PickupResult extends PickupRef {
  window: PickupWindow
  packageCount: number
}

// How the core names a shipment to the carrier: by the guide, or by the carrier's own id
export interface ShipmentRef {
  guideNumber: string
  providerShipmentId?: string
}

export interface CancelShipmentParams extends ShipmentRef {
  idempotencyKey: string
}

export interface CancelShipmentResult {
  cancelled: boolean
}

export interface FetchLabelParams extends ShipmentRef {
  format: LabelFormatType
}

export interface LocationQuery {
  parentId?: string
  search?: string
}

export interface CarrierLocation {
  id: string
  name: string
  parentId?: string
}

export interface CarrierEvent {
  providerEventId?: string
  // null when the plugin cannot map the carrier's code; the connection's own mapping is applied next
  status: ShipmentStatus | null
  rawStatus: string
  rawReason?: string
  description?: string
  occurredAt: string
  guideNumber?: string
  providerShipmentId?: string
}
