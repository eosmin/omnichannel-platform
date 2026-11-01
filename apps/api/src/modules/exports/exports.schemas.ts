import { z } from 'zod'

import { PaginationLimits } from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const listExportsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
})
export type ListExportsQuery = z.output<typeof listExportsQuerySchema>
