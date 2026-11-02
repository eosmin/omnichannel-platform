import { z } from 'zod'

import { PaginationLimits } from '@platform/core/domain'
import { ExportStatus, ExportTypes } from '@platform/core/exports'

import { cursorSchema } from '../customers/list-cursor'

// `type` and `status` narrow the list to one kind or one state. A value that is not one of ours is a
// malformed query (422), not an empty list. "expired" is a state of the list even for a row the
// cleanup has not marked yet (see `exportStatusWhere`).
export const listExportsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  type: z.enum(Object.values(ExportTypes) as [string, ...string[]]).optional(),
  status: z.enum(Object.values(ExportStatus) as [string, ...string[]]).optional()
})
export type ListExportsQuery = z.output<typeof listExportsQuerySchema>
