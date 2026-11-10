// The filter of the catalog page: the products the store sells, the archived ones or both. In a file of its
// own, with no import of the api client, so that the specs of its rules load nothing that reads the environment.
export const ProductFilters = { ALL: 'all', ACTIVE: 'active', ARCHIVED: 'archived' } as const
export type ProductFilter = (typeof ProductFilters)[keyof typeof ProductFilters]

// Whether a product, by its state, is shown under a filter of the page
const SHOWS: Record<ProductFilter, (isActive: boolean) => boolean> = {
  [ProductFilters.ALL]: () => true,
  [ProductFilters.ACTIVE]: isActive => isActive,
  [ProductFilters.ARCHIVED]: isActive => !isActive
}

export function matchesFilter(filter: ProductFilter, isActive: boolean): boolean {
  return SHOWS[filter](isActive)
}
