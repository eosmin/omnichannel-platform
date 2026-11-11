import type {
  GuideRefundStatus,
  LabelFormatType,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'

// The contract of a carrier plugin (TDD_17 §4.1). Each params and result type is the smallest shape the
// core needs, refined in Step 4.8 against §4.4, §4.5, §4.8 and §4.9: what the core writes first and sends,
// what it must read back to finish a shipment, and what it needs to recover one after an unknown outcome.

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
  // What the customer or the agent wrote for the courier; never the packing notes (TDD_17 §4.6)
  notes?: string
}

export interface CarrierLabel {
  format: LabelFormatType
  contentType: string
  data: Uint8Array
}

export interface CarrierCost {
  amountCents: number
  currency: string
}

export interface CreateShipmentResult {
  guideNumber: string
  providerShipmentId?: string
  trackingUrl?: string
  // What the carrier charged for the guide, when it says so
  cost?: CarrierCost
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

// One shipment of a batch: a guide, or the carrier's refusal of that shipment alone (TDD_17 §4.5: partial
// success is normal). A refusal of the whole call is a CarrierRejectedError, not a batch of refusals.
export const PickupBatchOutcomes = { CREATED: 'created', REJECTED: 'rejected' } as const
export type PickupBatchEntry =
  | { outcome: typeof PickupBatchOutcomes.CREATED; shipment: CreateShipmentResult }
  | { outcome: typeof PickupBatchOutcomes.REJECTED; message: string }

export interface PickupBatchResult {
  pickupRef: string
  // One entry per shipment of the batch, in the same order
  shipments: readonly PickupBatchEntry[]
}

export interface PickupRef {
  pickupRef: string
}

// The guides a pickup holds, each with the reference (order number) it was created for, so the core can match
// them to its own CREATING rows after an unknown outcome
export interface PickupGuide extends CreateShipmentResult {
  reference: string
}

export interface PickupDetails extends PickupRef {
  shipments: readonly PickupGuide[]
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

// How the core names a shipment to the carrier. The reference (order number) is the one thing the core always
// has, even when the outcome of a create is unknown and no guide came back: "check with the carrier"
// (TDD_17 §4.5) looks a shipment up by it.
export interface ShipmentRef {
  reference: string
  guideNumber?: string
  providerShipmentId?: string
}

// A shipment that has a guide: what cancelling and fetching a label need
export interface GuidedShipmentRef extends ShipmentRef {
  guideNumber: string
}

export interface CancelShipmentParams extends GuidedShipmentRef {
  idempotencyKey: string
}

// The carrier voided the guide. What it says about the refund is recorded as is (TDD_17 §4.8); a carrier that
// cannot void answers with a CarrierRejectedError, and one that cannot be reached with a CarrierUnavailableError
export interface CancelShipmentResult {
  refundStatus: GuideRefundStatus.PENDING | GuideRefundStatus.CONFIRMED
}

export interface FetchLabelParams extends GuidedShipmentRef {
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
  // The order number, when the carrier echoes it: it names a shipment whose guide the core never stored
  reference?: string
}
