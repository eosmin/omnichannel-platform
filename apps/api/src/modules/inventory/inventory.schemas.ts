import { z } from 'zod'

import {
  INVENTORY_SEARCH_MAX_LENGTH,
  InventoryAdjustmentReason,
  InventoryLevelSorts,
  InventoryLimits,
  InventoryMovementType,
  PaginationLimits,
  ProductLimits,
  singleLineText
} from '@platform/core/domain'

import { cursorSchema, type ListCursor } from '../customers/list-cursor'

// Where the next page of the ledger starts: the `seq` of the last movement it returned (opaque to clients)
export const seqCursorSchema = z.string().transform((text, ctx): bigint => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
    if (typeof parsed === 'string' && /^[0-9]{1,18}$/.test(parsed)) return BigInt(parsed)
  } catch {
    // Not JSON: the issue below says so
  }
  ctx.addIssue({ code: 'custom', message: 'not a cursor of this api' })
  return z.NEVER
})

export const encodeSeqCursor = (seq: bigint): string =>
  Buffer.from(JSON.stringify(seq.toString())).toString('base64url')

export const idSchema = z.uuid()

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(PaginationLimits.MAX)
  .default(PaginationLimits.DEFAULT)
const flag = z.enum(['true', 'false']).transform(value => value === 'true')

// Where the next page of the levels sorted by product name starts: the name and the id of the last level it returned
// (opaque to clients). It is only valid for that sort, as the (updatedAt, id) cursor is only valid for the other.
// A cursor is a name and an id in base64: far under this
const CURSOR_MAX_LENGTH = 2048

export interface NameCursor {
  name: string
  id: string
}

// An object, not the array of the other cursor: a cursor of one sort is refused by the other, never read as its own
export const encodeNameCursor = (row: NameCursor): string =>
  Buffer.from(JSON.stringify({ name: row.name, id: row.id })).toString('base64url')

const nameCursorParts = z.strictObject({
  name: z.string(),
  id: z.uuid()
})

function parseNameCursor(text: string): NameCursor | null {
  try {
    const parts = nameCursorParts.safeParse(
      JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
    )
    if (parts.success) return parts.data
  } catch {
    // Not JSON: the caller says so
  }
  return null
}

export type LevelCursor =
  | { sort: typeof InventoryLevelSorts.RECENT; position: ListCursor }
  | { sort: typeof InventoryLevelSorts.NAME; position: NameCursor }

// Stock is read for a product, for a warehouse, for the items that are low, or by a text (TDD_16 §6). The levels come
// newest-touched first, or by product name: the cursor belongs to the sort that made it.
export const listLevelsQuerySchema = z
  .strictObject({
    cursor: z.string().max(CURSOR_MAX_LENGTH).optional(),
    limit,
    warehouseId: idSchema.optional(),
    productId: idSchema.optional(),
    variantId: idSchema.optional(),
    lowStock: flag.optional(),
    // The name or SKU of the product, or of one of its variants
    q: z.string().trim().min(1).max(INVENTORY_SEARCH_MAX_LENGTH).optional(),
    sort: z.enum(Object.values(InventoryLevelSorts)).default(InventoryLevelSorts.RECENT)
  })
  .transform(({ cursor, ...rest }, ctx) => {
    let position: LevelCursor | undefined
    if (cursor !== undefined) {
      if (rest.sort === InventoryLevelSorts.NAME) {
        const parsed = parseNameCursor(cursor)
        if (parsed !== null) position = { sort: InventoryLevelSorts.NAME, position: parsed }
      } else {
        const parsed = cursorSchema.safeParse(cursor)
        if (parsed.success) position = { sort: InventoryLevelSorts.RECENT, position: parsed.data }
      }
      if (position === undefined) {
        ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'not a cursor of this api' })
        return z.NEVER
      }
    }
    return { ...rest, cursor: position }
  })

// The stock column of the catalog asks for the products of one page at once
export const stockSummaryQuerySchema = z.strictObject({
  productIds: z
    .string()
    .transform(text => text.split(','))
    .pipe(z.array(idSchema).min(1).max(PaginationLimits.MAX))
})

export const listMovementsQuerySchema = z.strictObject({
  cursor: seqCursorSchema.optional(),
  limit,
  warehouseId: idSchema.optional(),
  productId: idSchema.optional(),
  variantId: idSchema.optional(),
  type: z.enum(Object.values(InventoryMovementType)).optional()
})

// The kardex is one item in one warehouse: its running balance is the onHandAfter of each movement
export const kardexQuerySchema = z.strictObject({
  cursor: seqCursorSchema.optional(),
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
export type StockSummaryQuery = z.infer<typeof stockSummaryQuerySchema>
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>
export type KardexQuery = z.infer<typeof kardexQuerySchema>
export type CreateAdjustmentBody = z.infer<typeof createAdjustmentSchema>
