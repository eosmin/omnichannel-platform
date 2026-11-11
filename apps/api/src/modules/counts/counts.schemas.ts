import { z } from 'zod'

import {
  CountLimits,
  CountLineFilters,
  CountStatus,
  PaginationLimits,
  singleLineText
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = z.uuid()

export const listCountsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  status: z.enum(CountStatus).optional(),
  warehouseId: z.uuid().optional()
})

export const createCountSchema = z.strictObject({
  warehouseId: z.uuid(),
  // Limits the count to the products of one store of the organization
  storeId: z.uuid().optional(),
  note: singleLineText(CountLimits.NOTE_MAX_LENGTH, 1).optional()
})

// The quantities staff typed, a few rows at a time. A line is named once; null takes a quantity back (not counted).
export const updateCountLinesSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        countedQuantity: z.number().int().min(0).max(CountLimits.MAX_COUNTED_QUANTITY).nullable()
      })
    )
    .min(1)
    .max(CountLimits.MAX_LINES_PER_UPDATE)
    .refine(lines => new Set(lines.map(line => line.lineId)).size === lines.length, {
      message: 'a line is named once'
    })
})

export const countLinesQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  // Only the lines still to count, or only those whose count differs from the snapshot
  filter: z.enum(CountLineFilters).optional()
})

export type ListCountsQuery = z.infer<typeof listCountsQuerySchema>
export type CreateCountBody = z.infer<typeof createCountSchema>
export type UpdateCountLinesBody = z.infer<typeof updateCountLinesSchema>
export type CountLinesQuery = z.infer<typeof countLinesQuerySchema>
