import { orderListWhere } from './order-list-where'

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
      createdAt: { gte: from, lt: before }
    })
  })

  it('searches the number by prefix, a bare number as the padded one, and the customer by name, e-mail and phone', () => {
    const where = orderListWhere(STORE, { q: '#12' })
    const or = (where.AND?.[0] as { OR: Record<string, unknown>[] }).OR
    expect(or).toContainEqual({ orderNumber: { startsWith: '12' } })
    expect(or).toContainEqual({ orderNumber: '00012' })
    const customer = or.find(entry => 'customer' in entry) as {
      customer: { OR: Record<string, unknown>[] }
    }
    expect(customer.customer.OR).toHaveLength(2)
  })

  it('looks in the phones only for a text that is a phone, and never takes a wildcard as one', () => {
    const phone = orderListWhere(STORE, { q: '7123-4567' }).AND?.[0] as {
      OR: Record<string, unknown>[]
    }
    const customer = phone.OR.find(entry => 'customer' in entry) as {
      customer: { OR: Record<string, unknown>[] }
    }
    expect(customer.customer.OR).toContainEqual({ phoneNormalized: { contains: '71234567' } })
    const wild = orderListWhere(STORE, { q: '50%_' }).AND?.[0] as { OR: Record<string, unknown>[] }
    expect(JSON.stringify(wild)).toContain('50\\\\%\\\\_')
  })

  it('does not take a number longer than any number can be as one', () => {
    const where = orderListWhere(STORE, { q: '99999999999999' }).AND?.[0] as {
      OR: Record<string, unknown>[]
    }
    expect(where.OR).toContainEqual({ orderNumber: { startsWith: '99999999999999' } })
    expect(where.OR.some(entry => typeof entry['orderNumber'] === 'string')).toBe(false)
  })
})
