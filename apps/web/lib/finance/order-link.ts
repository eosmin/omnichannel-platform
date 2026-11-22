import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

// Where a book entry or a fiscal document leads to the order that made it: the order page of THAT store, and only for who may read the
// orders of that store (the permission is the store's, not the one the books are asked through). Null when the person may not, or when
// the entry names no store: a link to a page that answers "no access" is not offered.
export function orderHrefOf(
  memberships: readonly { storeId: string; permissions: readonly string[] }[],
  storeId: string | null,
  orderId: string | null
): string | null {
  if (storeId === null || orderId === null) return null
  const mayRead = memberships.some(
    membership =>
      membership.storeId === storeId &&
      membership.permissions.includes(ClientPermissions.ORDERS_VIEW)
  )
  return mayRead ? AppPaths.store.order(storeId, orderId) : null
}

// The store an entry's order lives in: the one its lines name (the lines of a sale carry the store of the sale). An entry whose lines
// name two stores is no sale of one order, so it names none.
export function storeOfEntryLines(lines: readonly { storeId: string | null }[]): string | null {
  const stores = new Set(lines.map(line => line.storeId).filter(id => id !== null))
  return stores.size === 1 ? ([...stores][0] ?? null) : null
}
