import { AppPaths } from '@platform/api-client'
import { ClientPermissions, type Permission } from '@platform/core/auth'
import { SearchEntities, type SearchEntity } from '@platform/core/domain'

// Which kinds of thing a member may search, read as the api reads them (`searchableBy`): the messages need both
// permissions, the rest one each. The api leaves out of every answer what the member may not search; this decides
// what the screen offers (the box, the tabs).
export function searchableKinds(can: (permission: Permission) => boolean): SearchEntity[] {
  const kinds: SearchEntity[] = []
  if (can(ClientPermissions.CUSTOMERS_VIEW)) kinds.push(SearchEntities.CUSTOMERS)
  if (can(ClientPermissions.CONVERSATIONS_VIEW) && can(ClientPermissions.MESSAGES_VIEW)) {
    kinds.push(SearchEntities.MESSAGES)
  }
  if (can(ClientPermissions.ORDERS_VIEW)) kinds.push(SearchEntities.ORDERS)
  if (can(ClientPermissions.PRODUCTS_VIEW)) kinds.push(SearchEntities.PRODUCTS)
  return kinds
}

// The page a hit opens. A message opens its conversation; a product opens the catalog with its name in the search
// box (the catalog has no address for one product yet). A customer has no page: the profile is a drawer that the
// screen opens (`useCustomerDrawer`), so there is no path, and the caller reads null as "open the drawer".
export function hitPath(
  storeId: string,
  hit:
    | { entity: typeof SearchEntities.CUSTOMERS; id: string }
    | { entity: typeof SearchEntities.MESSAGES; conversationId: string }
    | { entity: typeof SearchEntities.ORDERS; id: string }
    | { entity: typeof SearchEntities.PRODUCTS; name: string }
): string | null {
  switch (hit.entity) {
    case SearchEntities.CUSTOMERS:
      return null
    case SearchEntities.MESSAGES:
      return AppPaths.store.conversation(storeId, hit.conversationId)
    case SearchEntities.ORDERS:
      return AppPaths.store.order(storeId, hit.id)
    case SearchEntities.PRODUCTS:
      return `${AppPaths.store.products(storeId)}?q=${encodeURIComponent(hit.name)}`
  }
}
