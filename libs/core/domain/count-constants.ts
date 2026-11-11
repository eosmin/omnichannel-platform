import { InventoryLimits } from './inventory-constants'

// The physical counts of a warehouse (Step 4.6, TDD_16 §4.6).

export const CountLimits = {
  // A count of one warehouse holds at most this many lines (one per item with a level there), so a request and an apply
  // have a size: the apply is ONE transaction of the api (15 s), and each line with a variance is a stock movement of
  // several queries; a warehouse with more items is counted by store (the optional filter of the count)
  MAX_LINES: 2_000,
  // The lines one request may enter: staff count from a phone, a few rows at a time
  MAX_LINES_PER_UPDATE: 500,
  NOTE_MAX_LENGTH: 500,
  // The number printed on the sheet: CT-0001, CT-0002 ... unique inside the organization. The migration of the table
  // mirrors the prefix and the minimum of digits in `chk_stock_counts_number`, and bounds the digits at twelve
  NUMBER_PREFIX: 'CT-',
  NUMBER_MIN_DIGITS: 4,
  // What a person may type as a counted quantity: the same ceiling as one movement
  MAX_COUNTED_QUANTITY: InventoryLimits.MAX_MOVEMENT_QUANTITY
} as const

export const CountResourceTypes = {
  COUNT: 'stock_count',
  COUNT_LINES: 'stock_count_lines'
} as const

// Why a request on a count was refused with a 409, in `metadata.conflict`, for the screen to say so in words
export const CountConflicts = {
  // The warehouse has no item to count (nothing has a level there, or none of the store the count is limited to)
  NO_LINES: 'no_lines',
  // The warehouse has more items than a count holds
  TOO_MANY_LINES: 'too_many_lines',
  // The warehouse is switched off: nobody counts in it
  WAREHOUSE_INACTIVE: 'warehouse_inactive',
  // Applying would take the stock of these lines below zero: they go back to counting (`metadata.lines`)
  SHORT_STOCK: 'short_stock',
  // The engine refused lines for a reason that is not the stock (a product no longer tracked, the warehouse switched off or
  // unlinked from the store since the count started): `metadata.lines` names each line and the code it was refused with
  LINES_REFUSED: 'lines_refused'
} as const
export type CountConflict = (typeof CountConflicts)[keyof typeof CountConflicts]

// The store-wide-style advisory lock that makes two creators of a count of one organization take turns, so the numbers
// of the sheets follow each other without a gap or a repeat
export const CountLockScopes = {
  NUMBER: 'stock_count_number'
} as const

// What the lines of a count are filtered by: those still to count, or those whose count differs from the snapshot
export const CountLineFilters = {
  UNCOUNTED: 'uncounted',
  VARIANCE: 'variance'
} as const
export type CountLineFilter = (typeof CountLineFilters)[keyof typeof CountLineFilters]
