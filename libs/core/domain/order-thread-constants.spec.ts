import { customerOrderFigures, OrderLineLimits, OrderSummaryEvents } from './order-thread-constants'
import { OrderStatus } from './status-enums'

describe('OrderLineLimits', () => {
  it('holds every event and every state of an order, so the thread never drops a line for its length', () => {
    for (const event of Object.values(OrderSummaryEvents)) {
      expect(event.length).toBeLessThanOrEqual(OrderLineLimits.EVENT_MAX_LENGTH)
    }
    for (const status of Object.values(OrderStatus)) {
      expect(status.length).toBeLessThanOrEqual(OrderLineLimits.STATUS_MAX_LENGTH)
    }
  })
})

describe('customerOrderFigures', () => {
  const day = (n: number): Date => new Date(Date.UTC(2026, 0, n))

  it('is empty for a customer with no counted order', () => {
    expect(customerOrderFigures(undefined)).toEqual({
      orders: 0,
      byCurrency: [],
      firstOrderAt: null,
      lastOrderAt: null
    })
    expect(
      customerOrderFigures([
        { currency: 'USD', orders: 0, totalSpentCents: 0, firstOrderAt: null, lastOrderAt: null }
      ]).byCurrency
    ).toEqual([])
  })

  it('keeps each currency apart, sorted by code, rounds each average half up and spans the dates over all of them', () => {
    const figures = customerOrderFigures([
      {
        currency: 'USD',
        orders: 2,
        totalSpentCents: 3501,
        firstOrderAt: day(5),
        lastOrderAt: day(9)
      },
      {
        currency: 'EUR',
        orders: 1,
        totalSpentCents: 500,
        firstOrderAt: day(2),
        lastOrderAt: day(2)
      }
    ])

    expect(figures).toEqual({
      orders: 3,
      byCurrency: [
        { currency: 'EUR', orders: 1, totalSpentCents: 500, averageOrderCents: 500 },
        { currency: 'USD', orders: 2, totalSpentCents: 3501, averageOrderCents: 1751 }
      ],
      firstOrderAt: day(2),
      lastOrderAt: day(9)
    })
  })
})
