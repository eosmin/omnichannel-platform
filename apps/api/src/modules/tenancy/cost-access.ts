import { type Permission, Permissions } from '@platform/core/auth'

// The cost of a product and of its stock is the margin of the store (finance requirements, 2026-11-10): who may see
// it, and so who may set it, is decided here and nowhere else
export const mayViewCost = (held: readonly Permission[]): boolean =>
  held.includes(Permissions.PRODUCTS_VIEW_COST)
