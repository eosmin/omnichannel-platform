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
  MAX_MOVEMENT_QUANTITY: 1_000_000,
  // The daily reconciliation (TDD_16 §4.8) reads the levels of a store, and the stores, in pages of this many rows
  RECONCILE_PAGE_SIZE: 200,
  RECONCILE_STORES_PAGE_SIZE: 200
} as const

// How the stock screen of a store orders its levels: the ones touched last first (the default, what the cursor of
// the api has always followed), or by the name of the product
export const InventoryLevelSorts = {
  RECENT: 'recent',
  NAME: 'name'
} as const
export type InventoryLevelSort = (typeof InventoryLevelSorts)[keyof typeof InventoryLevelSorts]

// The keys of the query of GET /inventory/levels, which the address of the stock screen repeats as it is
export const InventoryLevelFilters = {
  Q: 'q',
  LOW_STOCK: 'lowStock',
  WAREHOUSE_ID: 'warehouseId',
  SORT: 'sort'
} as const

// The text a stock search may hold (the name or SKU of a product or a variant)
export const INVENTORY_SEARCH_MAX_LENGTH = 100

// The warehouse the owner bootstrap makes for an organization (and the dev fixtures use): a place for the stock of
// the first store. They are data: the owner renames them in the warehouses page.
export const DefaultWarehouse = {
  NAME: 'Main warehouse',
  CODE: 'MAIN'
} as const

// The priority of the first warehouse of a store (TDD_16 §4.1: 1 is reserved first)
export const FIRST_WAREHOUSE_PRIORITY = 1

// Why the platform refuses a movement or an adjustment with a 409: the `metadata.conflict` of the answer, next to the
// error code. One key can be used for one movement only (TDD_16 §4.2: a retry gives the same answer, a different
// request under the same key is a mistake).
export const InventoryConflicts = {
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused'
} as const

// Transfers between warehouses (TDD_16 §4.5)
export const TransferLimits = {
  // A transfer is read whole by its screens: one holds at most this many lines
  MAX_LINES: 200,
  NOTE_MAX_LENGTH: 500,
  // A dispatch, a receipt, a close or a cancel writes one movement per line in one transaction, so it gets more
  // time than the 15 s of an ordinary one
  TRANSACTION_TIMEOUT_MS: 60_000
} as const

// "TR-0001": the prefix and the least digits of the number of a transfer, per organization
export const TransferNumber = {
  PREFIX: 'TR-',
  MIN_DIGITS: 4
} as const

export const TransferResourceTypes = {
  TRANSFER: 'stock_transfer'
} as const

// The advisory lock that makes the creators of the transfers of one organization take turns (the number is the next
// one of the organization)
export const TransferLockScopes = {
  NUMBERS: 'transfer_numbers'
} as const

// The kinds of movement of a transfer in the ledger key `transfer:{id}:{lineId}:{kind}` (TDD_16 §4.2): a retry of the
// same step never applies twice. A receipt adds the client's receipt key, so that two receipts of one line are two
// movements and a retry of one is the same.
export const TransferMovementKeys = {
  DISPATCH: 'dispatch',
  RECEIVE: 'receive',
  // What comes back to the source when the transfer is cancelled in transit
  CANCEL_RETURN: 'cancel_return',
  // What comes back to the source when a close sends the shortage back
  SHORTAGE_RETURN: 'shortage_return'
} as const
