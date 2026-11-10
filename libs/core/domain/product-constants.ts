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
  HAS_HISTORY: 'has_history'
} as const
export type ProductConflict = (typeof ProductConflicts)[keyof typeof ProductConflicts]

// The tables that hold the history of a product, named in the answer of a refused delete
export const ProductHistoryTables = {
  ORDER_ITEMS: 'orderItems',
  INVENTORY_MOVEMENTS: 'inventoryMovements',
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
