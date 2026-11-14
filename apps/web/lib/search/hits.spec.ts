import { SearchEntities } from '@platform/core/domain'

import { flattenGroups, hitKey, pathOfHit } from './hits'

const customer = { id: 'c1', name: 'José', email: null, phone: null }
const order = {
  id: 'o1',
  orderNumber: 'ORD-1',
  status: 'pending',
  totalCents: 100,
  currency: 'USD',
  createdAt: '2026-01-01T00:00:00Z',
  customerId: 'c1',
  customerName: null
}
const message = {
  id: 'm1',
  conversationId: 'v1',
  type: 'text',
  createdAt: '2026-01-01T00:00:00Z',
  customerId: 'c1',
  customerName: null,
  snippet: 'hola'
}

describe('flattenGroups', () => {
  it('draws customers, orders, products and messages in that order, whatever the api sent first', () => {
    const flat = flattenGroups([
      { entity: SearchEntities.MESSAGES, hits: [message] },
      { entity: SearchEntities.ORDERS, hits: [order] },
      { entity: SearchEntities.CUSTOMERS, hits: [customer] }
    ])
    expect(flat.map(item => item.entity)).toEqual([
      SearchEntities.CUSTOMERS,
      SearchEntities.ORDERS,
      SearchEntities.MESSAGES
    ])
  })

  it('is empty when no group came back', () => {
    expect(flattenGroups([])).toEqual([])
  })
})

describe('hit keys and paths', () => {
  it('keys a hit by its kind, so equal ids of two kinds do not collide', () => {
    const [a, b] = flattenGroups([
      { entity: SearchEntities.CUSTOMERS, hits: [{ ...customer, id: 'x' }] },
      { entity: SearchEntities.ORDERS, hits: [{ ...order, id: 'x' }] }
    ])
    expect(a && b && hitKey(a) !== hitKey(b)).toBe(true)
  })

  it('has no path for a customer: the profile is a drawer', () => {
    const [item] = flattenGroups([{ entity: SearchEntities.CUSTOMERS, hits: [customer] }])
    expect(item && pathOfHit('s1', item)).toBeNull()
  })

  it('opens a message in its conversation', () => {
    const [item] = flattenGroups([{ entity: SearchEntities.MESSAGES, hits: [message] }])
    expect(item && pathOfHit('s1', item)).toBe('/s/s1/inbox/v1')
  })
})
