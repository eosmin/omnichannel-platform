import { z } from 'zod'

import {
  filterDaySchema,
  OrderReturnStatus,
  PaginationLimits,
  ReturnListLimits,
  ReceptionBatchStatus,
  uuidSchema
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const returnIdSchema = uuidSchema

// One page of the returns of the store, newest first. A cursor that is not ours is a malformed query (400).
export const listReturnsQuerySchema = z
  .strictObject({
    cursor: cursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PaginationLimits.MAX)
      .default(PaginationLimits.DEFAULT),
    status: z.enum(OrderReturnStatus).optional(),
    orderId: uuidSchema.optional(),
    // The number of the order as the store prints it (`00041`): the screen's filter by order, which a person does not know by id
    orderNumber: z.string().trim().min(1).max(ReturnListLimits.ORDER_NUMBER_MAX_LENGTH).optional(),
    // Calendar days on the clock of the store, both included
    createdFrom: filterDaySchema.optional(),
    createdTo: filterDaySchema.optional()
  })
  .refine(
    query =>
      query.createdFrom === undefined ||
      query.createdTo === undefined ||
      query.createdFrom <= query.createdTo,
    { message: 'the first day is after the last' }
  )
export type ListReturnsQuery = z.output<typeof listReturnsQuerySchema>

export const receptionIdSchema = uuidSchema

export const listReceptionBatchesQuerySchema = z.strictObject({
  status: z.enum(ReceptionBatchStatus).optional()
})
export type ListReceptionBatchesQuery = z.output<typeof listReceptionBatchesQuerySchema>
