import type { OrderOrderByWithRelationInput, OrderWhereInput } from '@platform/core/database'
import { calendarDayToDate, type OrderSort, OrderSorts } from '@platform/core/domain'

import type { OrderCursor } from './orders.schemas'

// The sorts of GET /orders and the keyset that pages them. Every sort ends in `createdAt desc, id desc` (the id is unique),
// so the position of a row is total: a page starts strictly after the last row of the one before and never repeats nor
// skips a row, even when many orders share a total, a customer or a day.

type After = (position: { createdAt: Date; id: string }) => OrderWhereInput[]

export function orderListOrderBy(sort: OrderSort): OrderOrderByWithRelationInput[] {
  const tail = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
  switch (sort) {
    case OrderSorts.SCHEDULED_DELIVERY:
      return [{ scheduledDeliveryDate: { sort: 'asc', nulls: 'last' } }, ...tail]
    case OrderSorts.TOTAL_HIGHEST:
      return [{ totalCents: 'desc' }, ...tail]
    case OrderSorts.CUSTOMER_NAME:
      return [{ customer: { nameSearch: 'asc' } }, ...tail]
    default:
      return tail
  }
}

// The condition of "strictly after the cursor" for the sort the cursor was made with
export function orderCursorWhere(
  sort: OrderSort,
  cursor: OrderCursor,
  after: After
): OrderWhereInput {
  switch (sort) {
    case OrderSorts.SCHEDULED_DELIVERY:
      // Soonest day first with the orders that have none last: after a day, the later days, the same day further down,
      // and every order with no day
      return cursor.day === null
        ? { scheduledDeliveryDate: null, OR: after(cursor) }
        : {
            OR: [
              { scheduledDeliveryDate: { gt: calendarDayToDate(cursor.day) } },
              { scheduledDeliveryDate: calendarDayToDate(cursor.day), OR: after(cursor) },
              { scheduledDeliveryDate: null }
            ]
          }
    case OrderSorts.TOTAL_HIGHEST: {
      // The schema refuses a cursor whose key does not fit the sort, so the key is a number here
      return {
        OR: [
          { totalCents: { lt: cursor.key as number } },
          { totalCents: cursor.key as number, OR: after(cursor) }
        ]
      }
    }
    case OrderSorts.CUSTOMER_NAME:
      // The schema refuses a cursor whose key is not a name, so the key is a string here. `name_search` is never null (the
      // database writes '' for a customer without a name), so those customers come first and the position stays total
      return {
        OR: [
          { customer: { nameSearch: { gt: cursor.key as string } } },
          { customer: { nameSearch: cursor.key as string }, OR: after(cursor) }
        ]
      }
    default:
      return { OR: after(cursor) }
  }
}

// What the next cursor remembers of the last row of the page, beyond its day, date and id
export function orderCursorKey(
  sort: OrderSort,
  last: { totalCents: number; customer: { nameSearch: string | null } }
): number | string | null {
  if (sort === OrderSorts.TOTAL_HIGHEST) return last.totalCents
  if (sort === OrderSorts.CUSTOMER_NAME) return last.customer.nameSearch ?? ''
  return null
}
