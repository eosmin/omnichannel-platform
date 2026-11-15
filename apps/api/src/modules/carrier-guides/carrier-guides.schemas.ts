import { z } from 'zod'

import { CarrierGuideLimits, uuidSchema } from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const carrierIdSchema = uuidSchema
export const movementIdSchema = uuidSchema

// One page of the movements of a connection, newest first. A cursor that is not ours, or a limit out of range, is a malformed
// query (400), not an empty page.
export const listGuideMovementsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CarrierGuideLimits.PAGE_SIZE_MAX)
    .default(CarrierGuideLimits.PAGE_SIZE_DEFAULT)
})
export type ListGuideMovementsQuery = z.output<typeof listGuideMovementsQuerySchema>
