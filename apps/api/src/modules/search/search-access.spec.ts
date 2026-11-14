import { Permissions } from '@platform/core/auth'
import { SearchEntities } from '@platform/core/domain'

import { GlobalSearchPermissions, searchableBy } from './search-access'

describe('what a member may search', () => {
  it('needs the permission to see conversations AND the one to read messages for the messages', () => {
    const kinds = (...held: Parameters<typeof searchableBy>[0]) => searchableBy(held)
    expect(
      kinds(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW).has(SearchEntities.MESSAGES)
    ).toBe(true)
    expect(kinds(Permissions.CONVERSATIONS_VIEW).has(SearchEntities.MESSAGES)).toBe(false)
    expect(kinds(Permissions.MESSAGES_VIEW).has(SearchEntities.MESSAGES)).toBe(false)
  })

  it('maps each other kind to its own view permission', () => {
    expect([...searchableBy([Permissions.CUSTOMERS_VIEW])]).toEqual([SearchEntities.CUSTOMERS])
    expect([...searchableBy([Permissions.ORDERS_VIEW])]).toEqual([SearchEntities.ORDERS])
    expect([...searchableBy([Permissions.PRODUCTS_VIEW])]).toEqual([SearchEntities.PRODUCTS])
    expect([...searchableBy([])]).toEqual([])
  })

  it('does not take a write permission for a view one', () => {
    expect([...searchableBy([Permissions.CUSTOMERS_EDIT, Permissions.ORDERS_CREATE])]).toEqual([])
  })

  it('opens the global search to anyone who can search at least one kind', () => {
    // Every permission a kind needs (the one that makes it unsearchable when it is missing) opens the global search:
    // otherwise a member could search a kind on its own route and be refused by the global one
    const every = Object.values(Permissions)
    const all = searchableBy(every).size
    expect(all).toBe(Object.values(SearchEntities).length)
    for (const permission of every) {
      const without = searchableBy(every.filter(other => other !== permission)).size
      if (without < all) expect(GlobalSearchPermissions).toContain(permission)
    }
  })
})
