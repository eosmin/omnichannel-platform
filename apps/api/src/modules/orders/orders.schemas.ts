import { z } from 'zod'

import {
  lowercasedUuidSchema,
  OrderConfirmationChannel,
  OrderLimits,
  orderListFilterShape,
  orderListFiltersAreConsistent,
  orderSortShape,
  PaginationLimits
} from '@platform/core/domain'

export const idSchema = lowercasedUuidSchema

// Postgres text cannot hold a NUL character: a 400 here and not a 500 there
const freeText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })

// The position of a page: the sort it was made with and the last row it returned. It holds where to go on and not a row
// to look for, so an order that changed meanwhile does not break the next page. Opaque to clients.
export interface OrderCursor {
  // The scheduled day of the last row ('YYYY-MM-DD'), or null: part of the position only when the list is sorted by it
  day: string | null
  createdAt: Date
  id: string
}

export function encodeOrderCursor(row: OrderCursor): string {
  return Buffer.from(JSON.stringify([row.day, row.createdAt.toISOString(), row.id])).toString(
    'base64url'
  )
}

const cursorParts = z.tuple([z.iso.date().nullable(), z.iso.datetime(), z.uuid()])

export const orderCursorSchema = z.string().transform((text, ctx): OrderCursor => {
  try {
    const parts = cursorParts.safeParse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')))
    if (parts.success) {
      return { day: parts.data[0], createdAt: new Date(parts.data[1]), id: parts.data[2] }
    }
  } catch {
    // Not JSON: the issue below says so
  }
  ctx.addIssue({ code: 'custom', message: 'not a cursor of this api' })
  return z.NEVER
})

export const listOrdersQuerySchema = z
  .strictObject({
    cursor: orderCursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PaginationLimits.MAX)
      .default(PaginationLimits.DEFAULT),
    ...orderListFilterShape,
    ...orderSortShape
  })
  .refine(orderListFiltersAreConsistent, {
    message: 'give days or a shortcut, never both, and the first day not after the last'
  })

// The export takes the filters of the list and no page and no sort: the file is the whole result
export const exportOrdersQuerySchema = z
  .strictObject(orderListFilterShape)
  .refine(orderListFiltersAreConsistent, {
    message: 'give days or a shortcut, never both, and the first day not after the last'
  })
export type ExportOrdersQuery = z.output<typeof exportOrdersQuerySchema>

export type ListOrdersQuery = z.output<typeof listOrdersQuerySchema>

// The single route to confirm: how the customer confirmed (TDD_17 §4.3); the moment of creation is not a way to
// confirm later
export const confirmOrderSchema = z.strictObject({
  via: z.enum([
    OrderConfirmationChannel.MESSAGE_REPLY,
    OrderConfirmationChannel.CALL,
    OrderConfirmationChannel.IN_PERSON,
    OrderConfirmationChannel.OTHER
  ])
})

export type ConfirmOrderBody = z.output<typeof confirmOrderSchema>

export const cancelOrderSchema = z.strictObject({
  cancellationReason: freeText(OrderLimits.CANCELLATION_REASON_MAX_LENGTH).min(1)
})

export type CancelOrderBody = z.output<typeof cancelOrderSchema>

// Approving or rejecting a price: the reason of a rejection is optional and goes to the audit entry
export const priceDecisionSchema = z.strictObject({
  reason: freeText(OrderLimits.PRICE_REASON_MAX_LENGTH).min(1).optional()
})

export type PriceDecisionBody = z.output<typeof priceDecisionSchema>
