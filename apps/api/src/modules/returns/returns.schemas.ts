import { z } from 'zod'

import {
  OrderReturnStatus,
  PaginationLimits,
  ReceptionBatchStatus,
  uuidSchema
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const returnIdSchema = uuidSchema

// One page of the returns of the store, newest first. A cursor that is not ours is a malformed query (400).
export const listReturnsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  status: z.enum(OrderReturnStatus).optional(),
  orderId: uuidSchema.optional()
})
export type ListReturnsQuery = z.output<typeof listReturnsQuerySchema>

export const receptionIdSchema = uuidSchema

export const listReceptionBatchesQuerySchema = z.strictObject({
  status: z.enum(ReceptionBatchStatus).optional()
})
export type ListReceptionBatchesQuery = z.output<typeof listReceptionBatchesQuerySchema>
