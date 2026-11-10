import { ProductFilters, type ProductFilter } from './use-products'

// Whether a product, by its state, is shown under a filter of the page
const SHOWS: Record<ProductFilter, (isActive: boolean) => boolean> = {
  [ProductFilters.ALL]: () => true,
  [ProductFilters.ACTIVE]: isActive => isActive,
  [ProductFilters.ARCHIVED]: isActive => !isActive
}

export function matchesFilter(filter: ProductFilter, isActive: boolean): boolean {
  return SHOWS[filter](isActive)
}
