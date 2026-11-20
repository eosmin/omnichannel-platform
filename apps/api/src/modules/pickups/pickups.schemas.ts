import { z } from 'zod'

import {
  isoDaySchema,
  PaginationLimits,
  PickupStatus,
  uuidSchema,
  queryIntSchema
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const pickupIdSchema = uuidSchema

// One page of the pickups of the store, newest first. A cursor that is not ours, or a limit out of range, is a malformed query.
export const listPickupsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: queryIntSchema(1, PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  status: z.enum(PickupStatus).optional(),
  connectionId: uuidSchema.optional(),
  from: isoDaySchema.optional(),
  to: isoDaySchema.optional()
})
export type ListPickupsQuery = z.output<typeof listPickupsQuerySchema>

export const pickupShipmentParamsSchema = z.strictObject({ id: uuidSchema, shipmentId: uuidSchema })
