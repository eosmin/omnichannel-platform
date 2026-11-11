// The limits of the catalog (Step 4.1). Amounts are USD cents, whole numbers (TDD_02 §13); the ceiling keeps a
// price, and the sums the orders make from it (Step 4.3), far from the 32 bits of the column.
export const ProductLimits = {
  NAME_MAX_LENGTH: 200,
  DESCRIPTION_MAX_LENGTH: 5000,
  SKU_MAX_LENGTH: 64,
  VARIANT_NAME_MAX_LENGTH: 100,
  // A product with more variants than this is a catalog that needs another model, not a bigger page
  MAX_VARIANTS_PER_PRODUCT: 100,
  // US$ 1,000,000.00
  MAX_AMOUNT_CENTS: 100_000_000,
  MAX_LOW_STOCK_THRESHOLD: 1_000_000,
  // The attributes of a variant: { size: "42", color: "red" }
  MAX_ATTRIBUTES: 10,
  ATTRIBUTE_KEY_MAX_LENGTH: 50,
  ATTRIBUTE_VALUE_MAX_LENGTH: 100
} as const

// What the unique indexes of the catalog protect: the SKU of a product in its store, and the name and the SKU of a
// variant in its product (the SKU of a variant is also unique in the whole store, checked by the service)
export const ProductConflicts = {
  SKU_IN_USE: 'sku_in_use',
  VARIANT_NAME_IN_USE: 'variant_name_in_use',
  TOO_MANY_VARIANTS: 'too_many_variants',
  // A product or variant that an order or a stock movement names is history of the store: it is archived, not deleted
  HAS_HISTORY: 'has_history',
  // Switching off the stock of a product whose units are on the road in a transfer in transit: the receipt (or the
  // return of a cancel) would be refused and the units stranded (Step 4.5)
  IN_TRANSIT: 'in_transit'
} as const
export type ProductConflict = (typeof ProductConflicts)[keyof typeof ProductConflicts]

// The tables that hold the history of a product, named in the answer of a refused delete
export const ProductHistoryTables = {
  ORDER_ITEMS: 'orderItems',
  INVENTORY_MOVEMENTS: 'inventoryMovements',
  // The stock level of the item in a warehouse (even one at zero): a product that has one is kept, not deleted
  INVENTORY_LEVELS: 'inventoryLevels',
  // A line of a transfer between warehouses, whatever its status (Step 4.5): its history names the product
  TRANSFER_LINES: 'transferLines',
  MEDIA: 'media'
} as const

export const ProductResourceTypes = {
  PRODUCT: 'product',
  VARIANT: 'product_variant'
} as const

// The store-wide advisory locks of the catalog (`lockStoreScope`): the SKU of a variant is unique in its whole store,
// and the database cannot say so, so the writers of a SKU take turns
export const ProductLockScopes = {
  VARIANT_SKU: 'product_variant_sku'
} as const

// The autocomplete of products (Step 4.1, TDD_08 §5). A text shorter than the minimum (in characters, after
// trimming) is not a search: it answers an empty list without touching the database (one letter would match half
// the catalog, and a wildcard typed alone is never a name). The text itself is required (a request with none is a
// 400), and one longer than the maximum is refused (400), not cut. The ceiling keeps the answer small and fast.
export const ProductSearchConfig = {
  MIN_QUERY_LENGTH: 2,
  MAX_QUERY_LENGTH: 100,
  DEFAULT_LIMIT: 8,
  MAX_LIMIT: 20
} as const
