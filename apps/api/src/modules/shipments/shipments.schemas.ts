import { z } from 'zod'

import {
  BulkLabelLimits,
  PaginationLimits,
  ShipmentStatus,
  uuidSchema
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const shipmentIdSchema = uuidSchema

// One page of the shipments of the store, newest first. A cursor that is not ours, or a limit out of range, is a malformed
// query (400), not an empty page.
// Ids that arrive as one comma-separated query value ('a,b,c'): the page of orders asks for the shipments of the rows it draws
const idList = z
  .string()
  // The longest honest list is a run of 36-character ids with commas: a longer text is refused before it is split
  .max(BulkLabelLimits.MAX_ORDERS * 37)
  .transform(text =>
    text
      .toLowerCase()
      .split(',')
      .filter(part => part !== '')
  )
  .pipe(
    z
      .array(uuidSchema)
      .min(1)
      .max(BulkLabelLimits.MAX_ORDERS)
      .refine(ids => new Set(ids).size === ids.length, { message: 'an order appears twice' })
  )

export const listShipmentsQuerySchema = z
  .strictObject({
    cursor: cursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PaginationLimits.MAX)
      .default(PaginationLimits.DEFAULT),
    status: z.enum(ShipmentStatus).optional(),
    connectionId: uuidSchema.optional(),
    orderId: uuidSchema.optional(),
    orderIds: idList.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional()
  })
  .refine(query => query.orderId === undefined || query.orderIds === undefined, {
    message: 'name one order or a list of orders, not both'
  })
export type ListShipmentsQuery = z.output<typeof listShipmentsQuerySchema>
