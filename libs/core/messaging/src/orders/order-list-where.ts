import {
  formatOrderNumber,
  type OrderGuideFilter,
  OrderGuideFilters,
  OrderEditablePriceStatuses,
  OrderNumber,
  PriceApprovalStatus,
  ShipmentInactiveStatuses,
  ShipmentKind
} from '@platform/core/domain'

import { escapeLike } from '../customers/customers.support'

// The orders of a store that the filters of the list and of the export find. Both read the rows with this one rule,
// so the file holds the rows the screen shows. The days are already resolved by the caller (it knows the clock of the
// store): the day an order was made as the instants it starts and ends at, the scheduled delivery as 'YYYY-MM-DD'.
export interface ResolvedOrderFilters {
  q?: string
  status?: string
  paymentStatus?: string
  priceApprovalStatus?: string
  customerId?: string
  // The planned carrier, and whether the order holds a live outbound guide
  carrierConnectionId?: string
  guide?: OrderGuideFilter
  // Inclusive start and exclusive end of the range of `createdAt`
  createdFrom?: Date
  createdBefore?: Date
}

// The characters a phone is written with, and at least three digits: the digits are looked for in the phones only then
const PHONE_LIKE = /^(?=(?:\D*\d){3})[\d\s+().-]+$/

// "#00012" is the number as the screens write it, and the search of a number is by prefix (TDD_08 §5.4); "12" is also the
// order 00012, whose number is padded with zeros
function orderNumberPrefix(q: string): string {
  return q.replace(/^#/, '')
}

function orderNumberConditions(q: string): Record<string, unknown>[] {
  const number = orderNumberPrefix(q)
  if (number.length === 0) return []
  const conditions: Record<string, unknown>[] = [
    { orderNumber: { startsWith: escapeLike(number) } }
  ]
  if (/^\d+$/.test(number) && Number(number) >= 1 && Number(number) <= OrderNumber.MAX) {
    conditions.push({ orderNumber: formatOrderNumber(Number(number)) })
  }
  return conditions
}

// What `findMany` and `count` of the orders take: the id of the store always, and only the conditions that were asked
export interface OrderListWhere {
  storeId: string
  status?: string
  paymentStatus?: string
  priceApprovalStatus?: string
  customerId?: string
  carrierConnectionId?: string
  createdAt?: { gte?: Date; lt?: Date }
  AND?: Record<string, unknown>[]
}

// A few digits (with or without the '#') is an order number: it must not also be read as the end of somebody's phone, or
// the list and the file would hold the orders and the contact data of people the person never meant
const ORDER_NUMBER_ONLY = /^#?\d{1,7}$/

// The patterns of a text for the customers it may name (name, e-mail, phone), as the database function reads them: contains-patterns,
// escaped, bound as parameters. null when the text is an order number only: it names no customer (see ORDER_NUMBER_ONLY).
export interface OrderTextCustomerPatterns {
  name: string
  email: string
  phone: string | null
}

export function orderTextCustomerPatterns(q: string): OrderTextCustomerPatterns | null {
  if (ORDER_NUMBER_ONLY.test(q)) return null
  const text = `%${escapeLike(q)}%`
  const digits = PHONE_LIKE.test(q) ? q.replace(/\D/g, '') : ''
  return { name: text, email: text, phone: digits === '' ? null : `%${digits}%` }
}

// `customerIds` are the customers the text names, found by `orderTextCustomerIds` (a database function: with row-level security on,
// only inside a definer function can the LIKE of a name use its trigram indexes). The customer of the order may be an absorbed one:
// the order keeps pointing at who made it.
export function orderTextWhere(q: string, customerIds: readonly string[]): Record<string, unknown> {
  if (ORDER_NUMBER_ONLY.test(q)) return { OR: orderNumberConditions(q) }
  return { OR: [...orderNumberConditions(q), { customerId: { in: [...customerIds] } }] }
}

// A live guide is an outbound one that is not cancelled, failed or returned: the statuses the one-active-guide index lists
export function orderGuideWhere(guide: OrderGuideFilter): Record<string, unknown> {
  const live = {
    shipments: {
      [guide === OrderGuideFilters.WITH ? 'some' : 'none']: {
        kind: ShipmentKind.OUTBOUND,
        status: { notIn: [...ShipmentInactiveStatuses] }
      }
    }
  }
  return live
}

// An order that is waiting for a decision on its price is one whose price can still be decided: a cancelled, shipped or delivered
// order keeps the `pending` it had (the decision never came and nothing is left to approve), and it is not one that waits
export function pendingPriceWhere(): Record<string, unknown> {
  return { status: { in: [...OrderEditablePriceStatuses] } }
}

// `textCustomerIds`: the customers the text of `filters.q` names (`orderTextCustomerIds`), empty when there is no text
export function orderListWhere(
  storeId: string,
  filters: ResolvedOrderFilters,
  textCustomerIds: readonly string[] = []
): OrderListWhere {
  return {
    storeId,
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.paymentStatus === undefined ? {} : { paymentStatus: filters.paymentStatus }),
    ...(filters.priceApprovalStatus === undefined
      ? {}
      : { priceApprovalStatus: filters.priceApprovalStatus }),
    ...(filters.customerId === undefined ? {} : { customerId: filters.customerId }),
    ...(filters.createdFrom === undefined && filters.createdBefore === undefined
      ? {}
      : {
          createdAt: {
            ...(filters.createdFrom === undefined ? {} : { gte: filters.createdFrom }),
            ...(filters.createdBefore === undefined ? {} : { lt: filters.createdBefore })
          }
        }),
    ...(filters.carrierConnectionId === undefined
      ? {}
      : { carrierConnectionId: filters.carrierConnectionId }),
    ...(filters.q === undefined &&
    filters.guide === undefined &&
    filters.priceApprovalStatus !== PriceApprovalStatus.PENDING
      ? {}
      : {
          AND: [
            ...(filters.q === undefined ? [] : [orderTextWhere(filters.q, textCustomerIds)]),
            ...(filters.guide === undefined ? [] : [orderGuideWhere(filters.guide)]),
            ...(filters.priceApprovalStatus === PriceApprovalStatus.PENDING
              ? [pendingPriceWhere()]
              : [])
          ]
        })
  }
}
