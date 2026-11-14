import type {
  CustomerSearchHitView,
  GlobalSearchGroupView,
  MessageSearchHitView,
  OrderSearchHitView,
  ProductSearchHitView
} from '@platform/api-client'
import { SearchEntities } from '@platform/core/domain'

import { hitPath } from './search-target'

// One hit of any kind, tagged with the kind, so the palette can walk them as one list
export type SearchHit =
  | { entity: typeof SearchEntities.CUSTOMERS; hit: CustomerSearchHitView }
  | { entity: typeof SearchEntities.MESSAGES; hit: MessageSearchHitView }
  | { entity: typeof SearchEntities.ORDERS; hit: OrderSearchHitView }
  | { entity: typeof SearchEntities.PRODUCTS; hit: ProductSearchHitView }

// The order the groups are drawn in. The api answers in its own order; a person looks for a customer or an order
// number first, so the screen does not depend on that.
const GROUP_ORDER = [
  SearchEntities.CUSTOMERS,
  SearchEntities.ORDERS,
  SearchEntities.PRODUCTS,
  SearchEntities.MESSAGES
] as const

export function flattenGroups(groups: readonly GlobalSearchGroupView[]): SearchHit[] {
  const flat: SearchHit[] = []
  for (const entity of GROUP_ORDER) {
    const group = groups.find(item => item.entity === entity)
    if (group === undefined) continue
    switch (group.entity) {
      case SearchEntities.CUSTOMERS:
        flat.push(...group.hits.map(hit => ({ entity: group.entity, hit })))
        break
      case SearchEntities.MESSAGES:
        flat.push(...group.hits.map(hit => ({ entity: group.entity, hit })))
        break
      case SearchEntities.ORDERS:
        flat.push(...group.hits.map(hit => ({ entity: group.entity, hit })))
        break
      case SearchEntities.PRODUCTS:
        flat.push(...group.hits.map(hit => ({ entity: group.entity, hit })))
        break
    }
  }
  return flat
}

export function hitKey(item: SearchHit): string {
  return `${item.entity}:${item.hit.id}`
}

// Null for a customer: the profile is a drawer, not a page
export function pathOfHit(storeId: string, item: SearchHit): string | null {
  switch (item.entity) {
    case SearchEntities.CUSTOMERS:
      return hitPath(storeId, { entity: item.entity, id: item.hit.id })
    case SearchEntities.MESSAGES:
      return hitPath(storeId, { entity: item.entity, conversationId: item.hit.conversationId })
    case SearchEntities.ORDERS:
      return hitPath(storeId, { entity: item.entity, id: item.hit.id })
    case SearchEntities.PRODUCTS:
      return hitPath(storeId, { entity: item.entity, name: item.hit.name })
  }
}
