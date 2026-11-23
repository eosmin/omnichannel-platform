import { Permissions } from '@platform/core/auth'

import { orderHrefOf, storeOfEntryLines } from './order-link'

const memberships = [
  { storeId: 'store-a', permissions: [Permissions.ORDERS_VIEW] },
  { storeId: 'store-b', permissions: [Permissions.FINANCE_VIEW] }
]

describe('orderHrefOf', () => {
  it('links to the order of the store where the person may read orders', () => {
    expect(orderHrefOf(memberships, 'store-a', 'order-1')).toBe('/s/store-a/orders/order-1')
  })

  it('offers no link for a store where the person may not read orders, even if they may in another', () => {
    expect(orderHrefOf(memberships, 'store-b', 'order-1')).toBeNull()
  })

  it('offers no link for a store the person does not belong to', () => {
    expect(orderHrefOf(memberships, 'store-z', 'order-1')).toBeNull()
  })

  it('offers no link without a store or without an order', () => {
    expect(orderHrefOf(memberships, null, 'order-1')).toBeNull()
    expect(orderHrefOf(memberships, 'store-a', null)).toBeNull()
  })
})

describe('storeOfEntryLines', () => {
  it('names the one store the lines carry', () => {
    expect(
      storeOfEntryLines([{ storeId: 'store-a' }, { storeId: null }, { storeId: 'store-a' }])
    ).toBe('store-a')
  })

  it('names none for lines of two stores or of no store', () => {
    expect(storeOfEntryLines([{ storeId: 'store-a' }, { storeId: 'store-b' }])).toBeNull()
    expect(storeOfEntryLines([{ storeId: null }])).toBeNull()
    expect(storeOfEntryLines([])).toBeNull()
  })
})
