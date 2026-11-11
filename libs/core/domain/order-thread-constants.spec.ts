import { CustomerFigureOrderStatuses, customerOrderFigures } from './order-thread-constants'
import { OrderStatus } from './status-enums'

describe('customerOrderFigures', () => {
  it('gives zeros and no average for a customer with no counted order', () => {
    const empty = {
      orders: 0,
      totalSpentCents: 0,
      averageOrderCents: null,
      firstOrderAt: null,
      lastOrderAt: null
    }
    expect(customerOrderFigures(undefined)).toEqual(empty)
    expect(
      customerOrderFigures({ orders: 0, totalSpentCents: 0, firstOrderAt: null, lastOrderAt: null })
    ).toEqual(empty)
  })

  it('divides in integer cents, rounding half up', () => {
    const first = new Date('2026-01-01T00:00:00Z')
    const last = new Date('2026-02-01T00:00:00Z')
    expect(
      customerOrderFigures({
        orders: 3,
        totalSpentCents: 10500,
        firstOrderAt: first,
        lastOrderAt: last
      })
    ).toEqual({
      orders: 3,
      totalSpentCents: 10500,
      averageOrderCents: 3500,
      firstOrderAt: first,
      lastOrderAt: last
    })
    expect(
      customerOrderFigures({
        orders: 2,
        totalSpentCents: 101,
        firstOrderAt: first,
        lastOrderAt: last
      }).averageOrderCents
    ).toBe(51)
    expect(
      customerOrderFigures({
        orders: 3,
        totalSpentCents: 100,
        firstOrderAt: first,
        lastOrderAt: last
      }).averageOrderCents
    ).toBe(33)
  })
})

describe('CustomerFigureOrderStatuses', () => {
  it('leaves out the orders not taken on yet and the ones that fell through', () => {
    expect(CustomerFigureOrderStatuses).not.toContain(OrderStatus.PENDING_CONFIRMATION)
    expect(CustomerFigureOrderStatuses).not.toContain(OrderStatus.CANCELLED)
    expect(CustomerFigureOrderStatuses).not.toContain(OrderStatus.RETURNED)
    expect(CustomerFigureOrderStatuses).toHaveLength(4)
  })
})
