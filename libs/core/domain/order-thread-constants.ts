import { OrderStatus } from './status-enums'

// What an ORDER_SUMMARY line of the thread says happened to the order (its `metadata.event`). The thread
// draws it as a card in the language of who reads it; it has no text of its own.
export const OrderSummaryEvents = {
  CREATED: 'created',
  STATUS_CHANGED: 'status_changed'
} as const
// The bounds of the strings of an ORDER_SUMMARY line: the thread of the web draws only what fits them, so a line
// cannot become a huge card. The writer validates `event` and `status` against their enums, and the unit spec of this
// file proves that every value of those enums fits, so a new state cannot become a line the page silently drops.
export const OrderLineLimits = {
  EVENT_MAX_LENGTH: 32,
  NUMBER_MAX_LENGTH: 64,
  STATUS_MAX_LENGTH: 32
} as const

export type OrderSummaryEvent = (typeof OrderSummaryEvents)[keyof typeof OrderSummaryEvents]

// The orders that count in the figures of a customer (orders, total spent, average order, first and
// last order): the ones the store has taken on. A pending one is not a purchase yet, and a cancelled or
// returned one is not one any more, so none of them is counted or added up. The timeline and the list of
// orders of the customer show every status.
export const CustomerFigureOrderStatuses = [
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED
] as const

// The money of a customer is never added across currencies: a store that changed its currency has orders in two, and
// "$120 + €80" is no figure. Each currency has its own line; the count and the dates are over every counted order.
export interface CustomerCurrencyFigures {
  currency: string
  orders: number
  totalSpentCents: number
  // Integer cents, rounded half up
  averageOrderCents: number
}

export interface CustomerOrderFigures {
  orders: number
  // One per currency the customer has counted orders in, sorted by the code of the currency; empty with no counted order
  byCurrency: CustomerCurrencyFigures[]
  firstOrderAt: Date | null
  lastOrderAt: Date | null
}

// What the database sums for one currency of a customer
export interface CustomerOrderAggregate {
  currency: string
  orders: number
  totalSpentCents: number
  firstOrderAt: Date | null
  lastOrderAt: Date | null
}

// One place that turns the sums of the database (one row per currency) into the figures that the profile and the CSV show,
// so the two never disagree about what the average is.
export function customerOrderFigures(
  aggregates: readonly CustomerOrderAggregate[] | undefined
): CustomerOrderFigures {
  const counted = (aggregates ?? []).filter(aggregate => aggregate.orders > 0)
  if (counted.length === 0) {
    return { orders: 0, byCurrency: [], firstOrderAt: null, lastOrderAt: null }
  }
  const moments = (pick: 'firstOrderAt' | 'lastOrderAt'): Date[] =>
    counted.flatMap(aggregate => (aggregate[pick] === null ? [] : [aggregate[pick]]))
  const first = moments('firstOrderAt').map(date => date.getTime())
  const last = moments('lastOrderAt').map(date => date.getTime())
  return {
    orders: counted.reduce((sum, aggregate) => sum + aggregate.orders, 0),
    byCurrency: counted
      .map(aggregate => ({
        currency: aggregate.currency,
        orders: aggregate.orders,
        totalSpentCents: aggregate.totalSpentCents,
        averageOrderCents: Math.round(aggregate.totalSpentCents / aggregate.orders)
      }))
      .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
    firstOrderAt: first.length === 0 ? null : new Date(Math.min(...first)),
    lastOrderAt: last.length === 0 ? null : new Date(Math.max(...last))
  }
}
