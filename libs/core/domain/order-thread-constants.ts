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

export interface CustomerOrderFigures {
  orders: number
  totalSpentCents: number
  // Integer cents, rounded half up; null when the customer has no counted order
  averageOrderCents: number | null
  firstOrderAt: Date | null
  lastOrderAt: Date | null
}

export interface CustomerOrderAggregate {
  orders: number
  totalSpentCents: number
  firstOrderAt: Date | null
  lastOrderAt: Date | null
}

// One place that turns the sums of the database into the figures that the profile and the CSV show, so
// the two never disagree about what the average is.
export function customerOrderFigures(
  aggregate: CustomerOrderAggregate | undefined
): CustomerOrderFigures {
  if (aggregate === undefined || aggregate.orders === 0) {
    return {
      orders: 0,
      totalSpentCents: 0,
      averageOrderCents: null,
      firstOrderAt: null,
      lastOrderAt: null
    }
  }
  return {
    orders: aggregate.orders,
    totalSpentCents: aggregate.totalSpentCents,
    averageOrderCents: Math.round(aggregate.totalSpentCents / aggregate.orders),
    firstOrderAt: aggregate.firstOrderAt,
    lastOrderAt: aggregate.lastOrderAt
  }
}
