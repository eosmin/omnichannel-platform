import { z } from 'zod'

import { PaginationLimits, ShipmentStatus, uuidSchema } from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const shipmentIdSchema = uuidSchema

// One page of the shipments of the store, newest first. A cursor that is not ours, or a limit out of range, is a malformed
// query (400), not an empty page.
export const listShipmentsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  status: z.enum(ShipmentStatus).optional(),
  connectionId: uuidSchema.optional(),
  orderId: uuidSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional()
})
export type ListShipmentsQuery = z.output<typeof listShipmentsQuerySchema>
