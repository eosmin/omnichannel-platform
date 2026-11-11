// The warehouses of an organization and their links to its stores (Step 4.2, TDD_16 §1 and §4.7).

export const WarehouseLimits = {
  // One organization holds at most this many warehouses, so the answer of a list has a size
  MAX_PER_ORGANIZATION: 200,
  ADDRESS_FIELD_MAX_LENGTH: 200,
  // The links one request may name: a warehouse serves the stores of one organization
  MAX_STORES_PER_REQUEST: 50,
  // What the owner types in the code box: ASCII letters, digits and . _ - (the database holds the same rule)
  CODE_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/
} as const

export const WarehouseResourceTypes = {
  WAREHOUSE: 'warehouse',
  // The store links of one warehouse
  STORE_LINKS: 'warehouse_store_links',
  // The inventory switches of a store (Settings → Inventory)
  INVENTORY_SETTINGS: 'inventory_settings'
} as const

// Why a request on a warehouse was refused with a 409, in `metadata.conflict`, for the screen to say so in words
export const WarehouseConflicts = {
  // Another warehouse of the organization has that code, whatever its letter case
  CODE_IN_USE: 'code_in_use',
  // A warehouse that is switched off takes no new store link
  INACTIVE: 'inactive'
} as const
export type WarehouseConflict = (typeof WarehouseConflicts)[keyof typeof WarehouseConflicts]

// What a refused deactivation or unlink reports in `metadata.reason`
export const WarehouseStockBlocks = {
  // Deactivating: the warehouse holds units (or reservations)
  DEACTIVATE: 'deactivate',
  // Unlinking: the store has reserved stock in that warehouse
  UNLINK: 'unlink',
  // A transfer in transit leaves from or arrives at the warehouse: its units are in no level, and the receipt (or the
  // return of a cancel) needs the warehouse on and the store linked to it (Step 4.5)
  OPEN_TRANSFER: 'open_transfer'
} as const

// The store-wide advisory lock that makes two writers of the links of one store take turns, so the priorities of the
// store are renumbered by one at a time (`lockStoreScope`)
export const WarehouseLockScopes = {
  STORE_LINKS: 'warehouse_store_links',
  // The inventory switches of a store are read and written back whole
  INVENTORY_SETTINGS: 'inventory_settings'
} as const
