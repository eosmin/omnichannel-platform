import {
  CodStatus,
  OrderReturnStatus,
  PickupStatus,
  PriceApprovalStatus,
  RemittanceStatus,
  ShipmentStatus
} from './status-enums'

export const CarrierId = { FORZA: 'forza', C807: 'c807', LOCAL: 'local' } as const
export type CarrierIdType = (typeof CarrierId)[keyof typeof CarrierId]

export const LabelFormat = {
  PDF_100X150: 'pdf_100x150',
  PDF_A6: 'pdf_a6',
  PDF_A4: 'pdf_a4'
} as const
export type LabelFormatType = (typeof LabelFormat)[keyof typeof LabelFormat]

// Each value is an i18n key.
export const OrderReturnReasons = {
  DEFECTIVE: 'orders.return.reason.DEFECTIVE',
  WRONG_ITEM: 'orders.return.reason.WRONG_ITEM',
  NOT_AS_DESCRIBED: 'orders.return.reason.NOT_AS_DESCRIBED',
  DAMAGED_IN_TRANSIT: 'orders.return.reason.DAMAGED_IN_TRANSIT',
  DELIVERY_FAILED: 'orders.return.reason.DELIVERY_FAILED',
  REFUSED_BY_CUSTOMER: 'orders.return.reason.REFUSED_BY_CUSTOMER',
  CHANGED_MIND: 'orders.return.reason.CHANGED_MIND',
  OTHER: 'orders.return.reason.OTHER'
} as const

export const CarrierCapability = {
  CREATE_SHIPMENT: 'create_shipment', // a guide can be created on its own (standalone carriers)
  // Guides exist only inside a pickup request: one call creates the pickup and returns the guides
  // of every shipment in it (TDD_17 §4.5). Replaces CREATE_SHIPMENT.
  PICKUP_BOUND_GUIDES: 'pickup_bound_guides',
  CANCEL_SHIPMENT: 'cancel_shipment',
  RETURN_SHIPMENT: 'return_shipment', // can create a guide from the customer to the warehouse
  IDEMPOTENT_CREATE: 'idempotent_create', // accepts our reference as a unique key: a retry never makes a second guide
  FETCH_STATUS: 'fetch_status', // polling
  WEBHOOK_STATUS: 'webhook_status', // pushes status changes
  PICKUP_REQUEST: 'pickup_request',
  PICKUP_MODIFY: 'pickup_modify', // the package count of an existing pickup can change
  PICKUP_CANCEL: 'pickup_cancel',
  REQUIRES_LOCATION_IDS: 'requires_location_ids', // the API needs the carrier's own department, municipality and settlement ids
  INTERNAL_GUIDE: 'internal_guide', // 'local' only: the platform generates the guide and label
  COD: 'cod' // supports cash on delivery
} as const
export type CarrierCapabilityType = (typeof CarrierCapability)[keyof typeof CarrierCapability]

// The statuses a carrier can report, and so the only valid targets of a status mapping. The other
// shipment statuses are driven by our own actions (TDD_17 §4.17).
export const CarrierReportableStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.LABEL_CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED
]

// One code for "Entregado", "ENTREGADO " and "entregádo": trimmed, lowercased, accents removed and
// inner whitespace collapsed. The single definition used to store and to look up a mapping.
export function normalizeProviderStatusCode(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// Transition tables, enforced inside the owning service (TDD_17 §3).

// Forward-only, with forward jumps allowed (TDD_17 §4.9). The last transition of CANCEL_FAILED is made by the agent
// ("mark as voided").
export const ShipmentStatusTransitions: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  [ShipmentStatus.CREATING]: [
    ShipmentStatus.LABEL_CREATED,
    ShipmentStatus.REQUIRES_REVIEW,
    ShipmentStatus.FAILED
  ],
  [ShipmentStatus.REQUIRES_REVIEW]: [ShipmentStatus.LABEL_CREATED, ShipmentStatus.FAILED],
  // A carrier may skip the intermediate events, so every later in-flight status is reachable
  [ShipmentStatus.LABEL_CREATED]: [
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.CANCEL_PENDING
  ],
  [ShipmentStatus.PICKED_UP]: [
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  [ShipmentStatus.IN_TRANSIT]: [
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  [ShipmentStatus.OUT_FOR_DELIVERY]: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  // A repeated attempt is a transition to itself: carriers usually try up to three times
  [ShipmentStatus.FAILED_ATTEMPT]: [
    ShipmentStatus.FAILED_ATTEMPT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED
  ],
  [ShipmentStatus.RETURNING]: [ShipmentStatus.RETURNED],
  [ShipmentStatus.CANCEL_PENDING]: [ShipmentStatus.CANCELLED, ShipmentStatus.CANCEL_FAILED],
  [ShipmentStatus.CANCEL_FAILED]: [ShipmentStatus.CANCEL_PENDING, ShipmentStatus.CANCELLED],
  [ShipmentStatus.DELIVERED]: [],
  [ShipmentStatus.RETURNED]: [],
  [ShipmentStatus.CANCELLED]: [],
  [ShipmentStatus.FAILED]: []
}

export const OrderReturnStatusTransitions: Record<OrderReturnStatus, readonly OrderReturnStatus[]> =
  {
    [OrderReturnStatus.REQUESTED]: [
      OrderReturnStatus.APPROVED,
      OrderReturnStatus.REJECTED,
      OrderReturnStatus.CANCELLED
    ],
    [OrderReturnStatus.APPROVED]: [
      OrderReturnStatus.IN_TRANSIT,
      OrderReturnStatus.RECEIVED,
      OrderReturnStatus.CANCELLED
    ],
    [OrderReturnStatus.IN_TRANSIT]: [OrderReturnStatus.RECEIVED],
    [OrderReturnStatus.RECEIVED]: [OrderReturnStatus.COMPLETED],
    [OrderReturnStatus.REJECTED]: [],
    [OrderReturnStatus.CANCELLED]: [],
    [OrderReturnStatus.COMPLETED]: []
  }

// PENDING appears when a discount is above the store's limit or a shipping fee is outside the
// carrier's range; PENDING returns to NOT_REQUIRED when the order is brought back within both.
export const PriceApprovalTransitions: Record<PriceApprovalStatus, readonly PriceApprovalStatus[]> =
  {
    [PriceApprovalStatus.NOT_REQUIRED]: [PriceApprovalStatus.PENDING],
    [PriceApprovalStatus.PENDING]: [
      PriceApprovalStatus.APPROVED,
      PriceApprovalStatus.REJECTED,
      PriceApprovalStatus.NOT_REQUIRED
    ],
    [PriceApprovalStatus.APPROVED]: [PriceApprovalStatus.PENDING],
    [PriceApprovalStatus.REJECTED]: [PriceApprovalStatus.PENDING, PriceApprovalStatus.NOT_REQUIRED]
  }

// NOT_APPLICABLE and VOID are terminal. REMITTED returns to PENDING_REMITTANCE when a remittance
// is voided.
export const CodStatusTransitions: Record<CodStatus, readonly CodStatus[]> = {
  [CodStatus.NOT_APPLICABLE]: [],
  [CodStatus.NOT_DELIVERED]: [CodStatus.PENDING_REMITTANCE, CodStatus.VOID],
  [CodStatus.PENDING_REMITTANCE]: [CodStatus.REMITTED, CodStatus.DISCREPANCY, CodStatus.VOID],
  [CodStatus.DISCREPANCY]: [CodStatus.REMITTED, CodStatus.PENDING_REMITTANCE],
  [CodStatus.REMITTED]: [CodStatus.PENDING_REMITTANCE],
  [CodStatus.VOID]: []
}

export const RemittanceStatusTransitions: Record<RemittanceStatus, readonly RemittanceStatus[]> = {
  [RemittanceStatus.DRAFT]: [RemittanceStatus.CONFIRMED],
  [RemittanceStatus.CONFIRMED]: [RemittanceStatus.VOIDED],
  [RemittanceStatus.VOIDED]: []
}

export const PickupStatusTransitions: Record<PickupStatus, readonly PickupStatus[]> = {
  [PickupStatus.PENDING]: [
    PickupStatus.REQUESTED,
    PickupStatus.MANUAL_REQUIRED,
    PickupStatus.REQUIRES_REVIEW,
    PickupStatus.FAILED
  ],
  [PickupStatus.REQUIRES_REVIEW]: [PickupStatus.REQUESTED, PickupStatus.FAILED],
  [PickupStatus.REQUESTED]: [PickupStatus.CONFIRMED, PickupStatus.CANCELLED, PickupStatus.FAILED],
  [PickupStatus.MANUAL_REQUIRED]: [PickupStatus.CONFIRMED, PickupStatus.CANCELLED],
  [PickupStatus.CONFIRMED]: [PickupStatus.CANCELLED],
  [PickupStatus.CANCELLED]: [],
  [PickupStatus.FAILED]: []
}
