import { type Permission, Permissions } from '@platform/core/auth'
import { SearchEntities, type SearchEntity } from '@platform/core/domain'

// The messages are searched by who may see conversations AND read messages: the route and the global search read this
export const MessageSearchPermissions = [
  Permissions.CONVERSATIONS_VIEW,
  Permissions.MESSAGES_VIEW
] as const

// Which kinds of thing a member may search, from their permissions: the ones the route of each kind asks for. The
// global search reads this to leave out of its groups what the member could not search on its own route.
export function searchableBy(held: readonly Permission[]): ReadonlySet<SearchEntity> {
  const kinds = new Set<SearchEntity>()
  if (MessageSearchPermissions.every(permission => held.includes(permission))) {
    kinds.add(SearchEntities.MESSAGES)
  }
  if (held.includes(Permissions.CUSTOMERS_VIEW)) kinds.add(SearchEntities.CUSTOMERS)
  if (held.includes(Permissions.ORDERS_VIEW)) kinds.add(SearchEntities.ORDERS)
  if (held.includes(Permissions.PRODUCTS_VIEW)) kinds.add(SearchEntities.PRODUCTS)
  return kinds
}

// The permissions that open the global search: any of the ones that open one of its kinds. A member with only some of
// a kind's permissions gets an answer with no group of it
export const GlobalSearchPermissions = [
  ...MessageSearchPermissions,
  Permissions.CUSTOMERS_VIEW,
  Permissions.ORDERS_VIEW,
  Permissions.PRODUCTS_VIEW
] as const
