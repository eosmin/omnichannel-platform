import { AppPaths } from '@platform/api-client'
import { ClientPermissions, type Permission } from '@platform/core/auth'
import { SearchEntities } from '@platform/core/domain'

import { hitPath, searchableKinds } from './search-target'

const canWith =
  (...held: Permission[]) =>
  (permission: Permission): boolean =>
    held.includes(permission)

describe('searchableKinds', () => {
  it('offers nothing to a member with no permission to read anything', () => {
    expect(searchableKinds(canWith())).toEqual([])
  })

  it('asks for both permissions to search the messages, as the api does', () => {
    expect(searchableKinds(canWith(ClientPermissions.CONVERSATIONS_VIEW))).toEqual([])
    expect(searchableKinds(canWith(ClientPermissions.MESSAGES_VIEW))).toEqual([])
    expect(
      searchableKinds(
        canWith(ClientPermissions.CONVERSATIONS_VIEW, ClientPermissions.MESSAGES_VIEW)
      )
    ).toEqual([SearchEntities.MESSAGES])
  })

  it('offers one kind for each permission', () => {
    expect(
      searchableKinds(
        canWith(
          ClientPermissions.CUSTOMERS_VIEW,
          ClientPermissions.ORDERS_VIEW,
          ClientPermissions.PRODUCTS_VIEW
        )
      )
    ).toEqual([SearchEntities.CUSTOMERS, SearchEntities.ORDERS, SearchEntities.PRODUCTS])
  })
})

describe('hitPath', () => {
  it('opens a message, an order and a product on their pages', () => {
    // A customer has no page of their own: the profile is a drawer, so there is no path to go to
    expect(hitPath('s1', { entity: SearchEntities.CUSTOMERS, id: 'c' })).toBeNull()
    expect(hitPath('s1', { entity: SearchEntities.MESSAGES, conversationId: 'v' })).toBe(
      AppPaths.store.conversation('s1', 'v')
    )
    expect(hitPath('s1', { entity: SearchEntities.ORDERS, id: 'o' })).toBe(
      AppPaths.store.order('s1', 'o')
    )
  })

  it('puts the name of a product in the catalog search, escaped', () => {
    expect(hitPath('s1', { entity: SearchEntities.PRODUCTS, name: 'Camisa & más' })).toBe(
      `${AppPaths.store.products('s1')}?q=Camisa%20%26%20m%C3%A1s`
    )
  })
})
