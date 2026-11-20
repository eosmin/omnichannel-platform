import { z } from 'zod'

import {
  PaginationLimits,
  RemittanceStatus,
  uuidSchema,
  queryIntSchema
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const remittanceIdSchema = uuidSchema

// One page of the remittances of the store, newest first. A cursor that is not ours, or a limit out of range, is a malformed
// query (400), not an empty page.
export const listRemittancesQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: queryIntSchema(1, PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  status: z.enum(RemittanceStatus).optional(),
  connectionId: uuidSchema.optional()
})
export type ListRemittancesQuery = z.output<typeof listRemittancesQuerySchema>
