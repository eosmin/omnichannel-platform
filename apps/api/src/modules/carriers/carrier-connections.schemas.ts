import { z } from 'zod'

import { PaginationLimits, uuidSchema } from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const connectionIdSchema = uuidSchema

// One page of the connections of the store, in order of creation. A cursor that is not ours, or a limit out of range, is a
// malformed query (400), not an empty page.
export const listCarriersQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
})
export type ListCarriersQuery = z.output<typeof listCarriersQuerySchema>
