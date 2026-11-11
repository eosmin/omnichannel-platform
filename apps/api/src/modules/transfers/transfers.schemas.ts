import { z } from 'zod'

import {
  InventoryLimits,
  PaginationLimits,
  singleLineText,
  TransferLimits,
  TransferShortageAction,
  TransferStatus
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = z.uuid()

const note = singleLineText(TransferLimits.NOTE_MAX_LENGTH, 1)
const quantity = z.number().int().min(1).max(InventoryLimits.MAX_MOVEMENT_QUANTITY)

// One item in one transfer: the store is the one of the product, never sent by the client
const lineSchema = z.strictObject({
  productId: idSchema,
  variantId: idSchema.optional(),
  quantity
})

const lines = z
  .array(lineSchema)
  .max(TransferLimits.MAX_LINES)
  .refine(
    items =>
      new Set(items.map(item => `${item.productId}:${item.variantId ?? ''}`)).size === items.length,
    { message: 'an item is named once' }
  )

export const listTransfersQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  status: z.enum(Object.values(TransferStatus)).optional(),
  // A transfer that leaves or arrives at this warehouse
  warehouseId: idSchema.optional()
})

export const createTransferSchema = z.strictObject({
  fromWarehouseId: idSchema,
  toWarehouseId: idSchema,
  note: note.optional(),
  lines: lines.default([])
})

// A draft is edited whole: the lines sent REPLACE the lines of the stores of the caller (the lines of stores the
// caller does not belong to are not theirs to change, and stay)
export const updateTransferSchema = z
  .strictObject({
    fromWarehouseId: idSchema.optional(),
    toWarehouseId: idSchema.optional(),
    note: note.nullable().optional(),
    lines: lines.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

// The client's, generated once per attempt (a UUID): a double click or a retry receives once
export const receiveTransferSchema = z.strictObject({
  receiptKey: z.uuid(),
  lines: z
    .array(z.strictObject({ lineId: idSchema, quantity }))
    .min(1)
    .max(TransferLimits.MAX_LINES)
})

export const closeTransferSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        lineId: idSchema,
        action: z.enum(Object.values(TransferShortageAction))
      })
    )
    .max(TransferLimits.MAX_LINES)
})

export type ListTransfersQuery = z.infer<typeof listTransfersQuerySchema>
export type CreateTransferBody = z.infer<typeof createTransferSchema>
export type UpdateTransferBody = z.infer<typeof updateTransferSchema>
export type ReceiveTransferBody = z.infer<typeof receiveTransferSchema>
export type CloseTransferBody = z.infer<typeof closeTransferSchema>
