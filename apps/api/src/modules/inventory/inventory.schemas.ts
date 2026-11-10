import { z } from 'zod'

import {
  InventoryAdjustmentReason,
  InventoryLimits,
  InventoryMovementType,
  PaginationLimits,
  ProductLimits,
  singleLineText
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = z.uuid()

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(PaginationLimits.MAX)
  .default(PaginationLimits.DEFAULT)
const flag = z.enum(['true', 'false']).transform(value => value === 'true')

// Stock is read for a product, for a warehouse, and for the items that are low (TDD_16 §6)
export const listLevelsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit,
  warehouseId: idSchema.optional(),
  productId: idSchema.optional(),
  variantId: idSchema.optional(),
  lowStock: flag.optional()
})

export const listMovementsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit,
  warehouseId: idSchema.optional(),
  productId: idSchema.optional(),
  variantId: idSchema.optional(),
  type: z.enum(Object.values(InventoryMovementType)).optional()
})

// The kardex is one item in one warehouse: its running balance is the onHandAfter of each movement
export const kardexQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit,
  productId: idSchema,
  variantId: idSchema.optional(),
  warehouseId: idSchema
})

// The types a person may record by hand (TDD_16 §4.3): a receipt is how stock enters, the adjustments correct it
const ManualTypes = [
  InventoryMovementType.RECEIPT,
  InventoryMovementType.ADJUSTMENT_IN,
  InventoryMovementType.ADJUSTMENT_OUT
] as const

export const createAdjustmentSchema = z.strictObject({
  warehouseId: idSchema,
  productId: idSchema,
  variantId: idSchema.optional(),
  type: z.enum(ManualTypes),
  quantity: z.number().int().min(1).max(InventoryLimits.MAX_MOVEMENT_QUANTITY),
  reason: z.enum(Object.values(InventoryAdjustmentReason)).optional(),
  note: singleLineText(InventoryLimits.NOTE_MAX_LENGTH, 1).optional(),
  // The client's, generated once per attempt (a UUID): a double click or a retry adjusts once
  idempotencyKey: z.uuid(),
  // The cost of ONE unit that comes in, in whole USD cents: setting a cost needs products:view_cost
  unitCostCents: z.number().int().min(0).max(ProductLimits.MAX_AMOUNT_CENTS).optional()
})

export type ListLevelsQuery = z.infer<typeof listLevelsQuerySchema>
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>
export type KardexQuery = z.infer<typeof kardexQuerySchema>
export type CreateAdjustmentBody = z.infer<typeof createAdjustmentSchema>
