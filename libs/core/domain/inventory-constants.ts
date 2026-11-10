import { CountStatus, InventoryMovementType, TransferStatus } from './status-enums'

// Enforced inside the owning service (TDD_16 §3). RECEIVED and CANCELLED are terminal.
export const TransferStatusTransitions: Record<TransferStatus, readonly TransferStatus[]> = {
  [TransferStatus.DRAFT]: [TransferStatus.IN_TRANSIT, TransferStatus.CANCELLED],
  [TransferStatus.IN_TRANSIT]: [TransferStatus.RECEIVED, TransferStatus.CANCELLED],
  [TransferStatus.RECEIVED]: [],
  [TransferStatus.CANCELLED]: []
}

// A count can go back from REVIEW to COUNTING. APPLIED and CANCELLED are terminal.
export const CountStatusTransitions: Record<CountStatus, readonly CountStatus[]> = {
  [CountStatus.DRAFT]: [CountStatus.COUNTING, CountStatus.CANCELLED],
  [CountStatus.COUNTING]: [CountStatus.REVIEW, CountStatus.CANCELLED],
  [CountStatus.REVIEW]: [CountStatus.COUNTING, CountStatus.APPLIED, CountStatus.CANCELLED],
  [CountStatus.APPLIED]: [],
  [CountStatus.CANCELLED]: []
}

// What each movement does to a level, as TDD_16 §3 says: -1, 0 or +1 times the (positive) quantity. The movement
// engine (InventoryService), the kardex and the reconciliation job all read this table, so the three agree.
export const InventoryMovementEffects: Record<
  InventoryMovementType,
  { readonly onHand: -1 | 0 | 1; readonly reserved: -1 | 0 | 1 }
> = {
  [InventoryMovementType.RECEIPT]: { onHand: 1, reserved: 0 },
  [InventoryMovementType.ISSUE]: { onHand: -1, reserved: -1 },
  [InventoryMovementType.RESERVE]: { onHand: 0, reserved: 1 },
  [InventoryMovementType.RELEASE]: { onHand: 0, reserved: -1 },
  [InventoryMovementType.ADJUSTMENT_IN]: { onHand: 1, reserved: 0 },
  [InventoryMovementType.ADJUSTMENT_OUT]: { onHand: -1, reserved: 0 },
  [InventoryMovementType.TRANSFER_OUT]: { onHand: -1, reserved: 0 },
  [InventoryMovementType.TRANSFER_IN]: { onHand: 1, reserved: 0 },
  [InventoryMovementType.COUNT_IN]: { onHand: 1, reserved: 0 },
  [InventoryMovementType.COUNT_OUT]: { onHand: -1, reserved: 0 },
  [InventoryMovementType.RETURN_IN]: { onHand: 1, reserved: 0 }
}

// The movements that bring units in: they carry the cost of one unit (`InventoryMovement.unitCostCents`, whole USD
// cents, null when it is not known), from which the weighted-average cost of the level is kept. The others take
// units out at the average cost of the level, or do not move value at all (reserve, release). Costing is the
// average now; FIFO lots can be built later from the receipts without changing the ledger.
export const InventoryMovementsThatBringUnitsIn: readonly InventoryMovementType[] = [
  InventoryMovementType.RECEIPT,
  InventoryMovementType.ADJUSTMENT_IN,
  InventoryMovementType.TRANSFER_IN,
  InventoryMovementType.COUNT_IN,
  InventoryMovementType.RETURN_IN
]

// The movements a person records by hand, which need a reason (`INVENTORY_ADJUSTMENT_REASON_REQUIRED`)
export const InventoryManualMovements: readonly InventoryMovementType[] = [
  InventoryMovementType.ADJUSTMENT_IN,
  InventoryMovementType.ADJUSTMENT_OUT
]

export const InventoryLimits = {
  IDEMPOTENCY_KEY_MAX_LENGTH: 200,
  NOTE_MAX_LENGTH: 500,
  WAREHOUSE_NAME_MAX_LENGTH: 100,
  WAREHOUSE_CODE_MAX_LENGTH: 20,
  // One movement moves at most this many units: a typo of a zero too many is a 400 and not a million units
  MAX_MOVEMENT_QUANTITY: 1_000_000
} as const

// The warehouse the owner bootstrap makes for an organization (and the dev fixtures use): a place for the stock of
// the first store. They are data: the owner renames them in the warehouses page.
export const DefaultWarehouse = {
  NAME: 'Main warehouse',
  CODE: 'MAIN'
} as const

// The priority of the first warehouse of a store (TDD_16 §4.1: 1 is reserved first)
export const FIRST_WAREHOUSE_PRIORITY = 1
