import {
  type MessageSearchHit,
  type OrderSearchHit,
  withoutMessageCustomer,
  withoutOrderCustomer
} from './search.views'

describe('what a plugin without customers:read sees of a hit', () => {
  const order: OrderSearchHit = {
    id: 'o1',
    orderNumber: 'T-1',
    status: 'PENDING',
    totalCents: 1999,
    currency: 'USD',
    createdAt: '2026-01-01T00:00:00.000Z',
    customerId: 'c1',
    customerName: 'Ana'
  }
  const message: MessageSearchHit = {
    id: 'm1',
    conversationId: 'k1',
    type: 'TEXT',
    createdAt: '2026-01-01T00:00:00.000Z',
    customerId: 'c1',
    customerName: 'Ana',
    snippet: 'hola'
  }

  it('drops the id and the name of the customer of an order and keeps the rest', () => {
    expect(withoutOrderCustomer(order)).toEqual({
      id: 'o1',
      orderNumber: 'T-1',
      status: 'PENDING',
      totalCents: 1999,
      currency: 'USD',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
  })

  it('drops the id and the name of the customer of a message and keeps the rest', () => {
    expect(withoutMessageCustomer(message)).toEqual({
      id: 'm1',
      conversationId: 'k1',
      type: 'TEXT',
      createdAt: '2026-01-01T00:00:00.000Z',
      snippet: 'hola'
    })
  })

  it('lets a field through only when it is named: one added to a hit stays out', () => {
    const hit = { ...order, phone: '71234567' } as OrderSearchHit

    expect(Object.keys(withoutOrderCustomer(hit))).not.toContain('phone')
  })
})
