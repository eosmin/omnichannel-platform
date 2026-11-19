import { orderListWhere, orderTextCustomerPatterns } from './order-list-where'

const STORE = 'store-1'

describe('orderListWhere', () => {
  it('is only the store when nothing is asked', () => {
    expect(orderListWhere(STORE, {})).toEqual({ storeId: STORE })
  })

  it('carries each filter that was asked and the range of the day it was made', () => {
    const from = new Date('2026-11-10T06:00:00Z')
    const before = new Date('2026-11-11T06:00:00Z')
    expect(
      orderListWhere(STORE, {
        status: 'SHIPPED',
        paymentStatus: 'PENDING',
        priceApprovalStatus: 'pending',
        customerId: 'c1',
        createdFrom: from,
        createdBefore: before
      })
    ).toEqual({
      storeId: STORE,
      status: 'SHIPPED',
      paymentStatus: 'PENDING',
      priceApprovalStatus: 'pending',
      customerId: 'c1',
      createdAt: { gte: from, lt: before },
      AND: [{ status: { in: ['PENDING_CONFIRMATION', 'CONFIRMED', 'PREPARING'] } }]
    })
  })

  it('does not list as waiting for a price an order whose price can no longer be decided', () => {
    // A cancelled order keeps the `pending` it had; the filter of the orders that wait must not return it
    expect(orderListWhere(STORE, { priceApprovalStatus: 'pending' }).AND).toEqual([
      { status: { in: ['PENDING_CONFIRMATION', 'CONFIRMED', 'PREPARING'] } }
    ])
    expect(orderListWhere(STORE, { priceApprovalStatus: 'approved' }).AND).toBeUndefined()
    expect(orderListWhere(STORE, { priceApprovalStatus: 'rejected' }).AND).toBeUndefined()
    // It joins the text filter and does not replace it
    expect(orderListWhere(STORE, { priceApprovalStatus: 'pending', q: 'ana' }).AND).toHaveLength(2)
  })

  it('filters by the planned carrier and by whether a live outbound guide holds the order', () => {
    expect(orderListWhere(STORE, { carrierConnectionId: 'conn-1' })).toEqual({
      storeId: STORE,
      carrierConnectionId: 'conn-1'
    })
    const live = { kind: 'outbound', status: { notIn: ['cancelled', 'failed', 'returned'] } }
    expect(orderListWhere(STORE, { guide: 'with_guide' })).toEqual({
      storeId: STORE,
      AND: [{ shipments: { some: live } }]
    })
    expect(orderListWhere(STORE, { guide: 'without_guide' })).toEqual({
      storeId: STORE,
      AND: [{ shipments: { none: live } }]
    })
  })

  it('keeps the text search next to the guide filter', () => {
    const where = orderListWhere(STORE, { q: '12', guide: 'with_guide' })
    expect(where.AND).toHaveLength(2)
  })

  it('searches the number by prefix, a bare number as the padded one, and the customers the text names by their ids', () => {
    const where = orderListWhere(STORE, { q: 'ana' }, ['c1', 'c2'])
    const or = (where.AND?.[0] as { OR: Record<string, unknown>[] }).OR
    expect(or).toContainEqual({ orderNumber: { startsWith: 'ana' } })
    expect(or).toContainEqual({ customerId: { in: ['c1', 'c2'] } })
    const bare = orderListWhere(STORE, { q: '#12' }).AND?.[0] as { OR: Record<string, unknown>[] }
    expect(bare.OR).toContainEqual({ orderNumber: '00012' })
  })

  it('reads a few digits as an order number only, never as the end of a phone or a name', () => {
    for (const q of ['12', '#00012', '1234567']) {
      const where = orderListWhere(STORE, { q }, ['c1']).AND?.[0] as {
        OR: Record<string, unknown>[]
      }
      expect(where.OR.some(entry => 'customerId' in entry)).toBe(false)
      expect(orderTextCustomerPatterns(q)).toBeNull()
    }
    expect(orderTextCustomerPatterns('12345678')?.phone).toBe('%12345678%')
  })

  it('names no customer when the text names none: an empty list, never every order', () => {
    const where = orderListWhere(STORE, { q: 'zzz' }, []).AND?.[0] as {
      OR: Record<string, unknown>[]
    }
    expect(where.OR).toContainEqual({ customerId: { in: [] } })
  })

  it('looks in the phones only for a text that is a phone, and never takes a wildcard as one', () => {
    expect(orderTextCustomerPatterns('7123-4567')?.phone).toBe('%71234567%')
    expect(orderTextCustomerPatterns('Calle 12')?.phone).toBeNull()
    expect(orderTextCustomerPatterns('50%_')).toEqual({
      name: '%50\\%\\_%',
      email: '%50\\%\\_%',
      phone: null
    })
  })

  it('does not take a number longer than any number can be as one', () => {
    const where = orderListWhere(STORE, { q: '99999999999999' }).AND?.[0] as {
      OR: Record<string, unknown>[]
    }
    expect(where.OR).toContainEqual({ orderNumber: { startsWith: '99999999999999' } })
    expect(where.OR.some(entry => typeof entry['orderNumber'] === 'string')).toBe(false)
  })
})
