import type {
  InventoryAdjustmentReason,
  InventoryMovementType,
  InventoryReferenceType
} from '@platform/core/domain'

// One change of stock (TDD_16 §4.2). `quantity` is always positive and `type` carries the direction. The store is the
// one of the caller (TenantGuard, or the order the movement belongs to): the service never reads it from anywhere else.
export interface MovementInput {
  storeId: string
  productId: string
  // Null for a product with no variants
  variantId?: string | null
  warehouseId: string
  type: InventoryMovementType
  quantity: number
  // The caller's, unique inside the store: a movement made for an order, a transfer or a count carries a
  // deterministic one (`order:{orderId}:{lineId}:reserve`), so a retry never applies twice
  idempotencyKey: string
  // The cost of ONE unit, in whole USD cents, for the movements that bring units in; null or absent when it is not
  // known (the units then come in at the average cost of the level). Refused on any other type.
  unitCostCents?: number | null
  // Mandatory for a manual adjustment; for a receipt, the reason or a note
  reason?: InventoryAdjustmentReason | null
  note?: string | null
  reference?: { type: InventoryReferenceType; id?: string | null } | null
  createdBy?: string | null
}

export interface MovementRecord {
  id: string
  storeId: string
  productId: string
  variantId: string | null
  warehouseId: string
  type: InventoryMovementType
  quantity: number
  reason: InventoryAdjustmentReason | null
  note: string | null
  referenceType: InventoryReferenceType | null
  referenceId: string | null
  idempotencyKey: string
  // What one unit that moved was worth: the one the movement brought, or the average cost of the level when it left
  unitCostCents: number | null
  onHandAfter: number
  reservedAfter: number
  createdBy: string | null
  createdAt: Date
}

export interface MovementResult {
  movement: MovementRecord
  // true when the key had been used by the same request: nothing was applied now, `movement` is the original
  replayed: boolean
}

// A level and what its ledger says it must be (the reconciliation of TDD_16 §4.8)
export interface LevelCheck {
  actual: { onHand: number; reserved: number; valueCents: bigint }
  expected: { onHand: number; reserved: number; valueCents: bigint }
  matches: boolean
}
