import { z } from 'zod'

import {
  changeOrderStatusSchema,
  createOrderSchema,
  lowercasedUuidSchema,
  OrderConfirmationChannel,
  OrderLimits,
  orderListFiltersAreConsistent,
  orderListFilterShape,
  orderSortShape,
  PaginationLimits,
  recordOrderPaymentSchema,
  updateOrderSchema,
  queryIntSchema
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

const cursorParts = z.tuple([z.iso.date().nullable(), z.iso.datetime(), lowercasedUuidSchema])

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

const orderPageShape = {
  cursor: orderCursorSchema.optional(),
  limit: queryIntSchema(1, PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
}

export const listOrdersQuerySchema = z
  .strictObject({
    ...orderPageShape,
    ...orderListFilterShape,
    ...orderSortShape
  })
  .refine(orderListFiltersAreConsistent, {
    message: 'give days or a shortcut, never both, and the first day not after the last'
  })

// What a plugin may filter by: not the text search (it matches the name, email and phone of the customer), not the customer, and not
// the guide or the carrier (shipping data). The price approval status IS a filter: a plugin that holds `orders:approve-price` lists the
// orders that wait for it (PR E3b). A name it is not given is a 400, as for any other the schema does not know.
export const pluginListOrdersQuerySchema = z
  .strictObject({
    ...orderPageShape,
    ...z.strictObject(orderListFilterShape).omit({
      q: true,
      customerId: true,
      carrierConnectionId: true,
      guide: true
    }).shape,
    ...orderSortShape
  })
  .refine(orderListFiltersAreConsistent, {
    message: 'give days or a shortcut, never both, and the first day not after the last'
  })
export type PluginListOrdersQuery = z.output<typeof pluginListOrdersQuerySchema>

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

// "Mark as confirmed" over the selection of the list: one way of confirming for all of them, each order a change of its own
export const confirmOrdersBulkSchema = z.strictObject({
  ids: z
    .array(idSchema)
    .min(1)
    .max(OrderLimits.BULK_CONFIRM_MAX)
    .refine(ids => new Set(ids).size === ids.length, { message: 'an order is named twice' }),
  via: confirmOrderSchema.shape.via
})

export type ConfirmOrdersBulkBody = z.output<typeof confirmOrdersBulkSchema>

export const cancelOrderSchema = z.strictObject({
  cancellationReason: freeText(OrderLimits.CANCELLATION_REASON_MAX_LENGTH).min(1),
  // The "Notify customer" box: left out, the `autoSend` of the cancellation template decides
  notifyCustomer: z.boolean().optional()
})

export type CancelOrderBody = z.output<typeof cancelOrderSchema>

// Approving or rejecting a price: the reason of a rejection is optional and goes to the audit entry
export const priceDecisionSchema = z.strictObject({
  reason: freeText(OrderLimits.PRICE_REASON_MAX_LENGTH).min(1).optional()
})

export type PriceDecisionBody = z.output<typeof priceDecisionSchema>

// What a plugin may write of an order (Step 5.6 PR E3b): the schemas of the people with the fields a plugin must not touch refused,
// each with its own message (a 400, as for a name the schema does not know). The internal and packing notes are the team's and a
// plugin never reads them, so it does not overwrite them either; the tracking number belongs to the guide (`shipments:write`); a
// conversation is linked only by who may see the inbox, which no scope of an order grants; and the summary message goes through
// the route of the messages, with its own scope, not as a flag of the creation.
const REFUSED_FOR_PLUGINS = 'a plugin does not write this field of an order'

export const pluginCreateOrderSchema = createOrderSchema.superRefine((body, ctx) => {
  const refused = {
    conversationId: body.conversationId,
    internalNotes: body.internalNotes,
    packingNotes: body.packingNotes,
    sendConfirmationMessage: body.sendConfirmationMessage,
    // Naming the order it was copied from tells whether that order exists, which needs `orders:read`: a plugin creates the order from
    // the lines of the draft and does not link it
    copiedFromOrderId: body.copiedFromOrderId
  }
  for (const [path, value] of Object.entries(refused)) {
    if (value !== undefined)
      ctx.addIssue({ code: 'custom', path: [path], message: REFUSED_FOR_PLUGINS })
  }
})

export const pluginUpdateOrderSchema = updateOrderSchema.superRefine((body, ctx) => {
  const refused = {
    internalNotes: body.internalNotes,
    packingNotes: body.packingNotes,
    trackingNumber: body.trackingNumber,
    // What the customer wrote is withheld from a plugin, so it does not overwrite or clear it either
    customerNotes: body.customerNotes
  }
  for (const [path, value] of Object.entries(refused)) {
    if (value !== undefined)
      ctx.addIssue({ code: 'custom', path: [path], message: REFUSED_FOR_PLUGINS })
  }
})

// The proof of delivery is a file of the store that only a person uploads (no scope grants an upload), so a plugin does not name one
// A plugin does not tell the customer through a status either: the automatic message follows a change made by a person, so the flag
// would be ignored in silence; the message goes through `order-messages:write`
export const pluginChangeOrderStatusSchema = changeOrderStatusSchema.superRefine((body, ctx) => {
  const refused = {
    proofOfDeliveryMediaId: body.proofOfDeliveryMediaId,
    notifyCustomer: body.notifyCustomer
  }
  for (const [path, value] of Object.entries(refused)) {
    if (value !== undefined)
      ctx.addIssue({ code: 'custom', path: [path], message: REFUSED_FOR_PLUGINS })
  }
})

export const pluginCancelOrderSchema = cancelOrderSchema.superRefine((body, ctx) => {
  if (body.notifyCustomer !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['notifyCustomer'], message: REFUSED_FOR_PLUGINS })
  }
})

// The receipt of a payment is a file a person uploaded (no scope grants an upload), so a plugin does not name one either
export const pluginRecordOrderPaymentSchema = recordOrderPaymentSchema.superRefine((body, ctx) => {
  if (body.proofMediaId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['proofMediaId'], message: REFUSED_FOR_PLUGINS })
  }
})
