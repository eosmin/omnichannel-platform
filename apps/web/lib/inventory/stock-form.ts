import type { ProductDetailView, StockAdjustmentInput } from '@platform/api-client'
import {
  InventoryAdjustmentReason,
  InventoryLimits,
  InventoryMovementEffects,
  InventoryMovementType,
  ProductLimits
} from '@platform/core/domain'

import { parseCents } from '../products/money'

// What a person does to the stock of an item, in the words of the screen. The api speaks of a receipt and of an
// adjustment in or out (TDD_16 §4.3); a receipt is how stock enters, the adjustments correct it.
export const StockActions = { RECEIVE: 'receive', ADD: 'add', REMOVE: 'remove' } as const
export type StockAction = (typeof StockActions)[keyof typeof StockActions]

const TYPE_OF: Record<StockAction, StockAdjustmentInput['type']> = {
  [StockActions.RECEIVE]: InventoryMovementType.RECEIPT,
  [StockActions.ADD]: InventoryMovementType.ADJUSTMENT_IN,
  [StockActions.REMOVE]: InventoryMovementType.ADJUSTMENT_OUT
}

// The reasons each action offers, the first one being what the form starts with
export const ReasonsOf: Record<StockAction, readonly InventoryAdjustmentReason[]> = {
  [StockActions.RECEIVE]: [
    InventoryAdjustmentReason.OPENING_STOCK,
    InventoryAdjustmentReason.OTHER
  ],
  [StockActions.ADD]: [
    InventoryAdjustmentReason.FOUND,
    InventoryAdjustmentReason.CORRECTION,
    InventoryAdjustmentReason.OTHER
  ],
  [StockActions.REMOVE]: [
    InventoryAdjustmentReason.DAMAGED,
    InventoryAdjustmentReason.LOST,
    InventoryAdjustmentReason.CORRECTION,
    InventoryAdjustmentReason.OTHER
  ]
}

export interface StockFormValues {
  warehouseId: string
  // '' is the product itself (a product with no variants)
  variantId: string
  action: StockAction
  quantity: string
  reason: InventoryAdjustmentReason
  note: string
  // The cost of one unit that comes in, in dollars: only asked of who may see costs
  unitCost: string
}

export type StockFormField = 'warehouse' | 'variant' | 'quantity' | 'note' | 'unitCost'

export type StockResult =
  | { ok: true; value: Omit<StockAdjustmentInput, 'idempotencyKey'> }
  | { ok: false; field: StockFormField }

export function emptyStockForm(warehouseId = ''): StockFormValues {
  return {
    warehouseId,
    variantId: '',
    action: StockActions.RECEIVE,
    quantity: '',
    reason: InventoryAdjustmentReason.OPENING_STOCK,
    note: '',
    unitCost: ''
  }
}

// Whole units, no sign, no separator, up to what a movement may move
const WHOLE_UNITS = /^\d{1,7}$/

export function parseUnits(text: string): number | null {
  const trimmed = text.trim()
  if (!WHOLE_UNITS.test(trimmed)) return null
  const units = Number(trimmed)
  return units >= 1 && units <= InventoryLimits.MAX_MOVEMENT_QUANTITY ? units : null
}

// What the person typed, as the body of the adjustment (without its key, which is made once per attempt), or the field
// that is wrong. A product that has variants is adjusted by variant, except to take out what sits on its bare row.
export function adjustmentFrom(
  values: StockFormValues,
  product: Pick<ProductDetailView, 'id' | 'variants'>,
  canSetCost: boolean
): StockResult {
  if (values.warehouseId === '') return { ok: false, field: 'warehouse' }
  const hasVariants = product.variants.some(variant => variant.active)
  if (values.variantId === '' && hasVariants && values.action !== StockActions.REMOVE) {
    return { ok: false, field: 'variant' }
  }
  const quantity = parseUnits(values.quantity)
  if (quantity === null) return { ok: false, field: 'quantity' }
  const note = values.note.trim()
  if (note.length > InventoryLimits.NOTE_MAX_LENGTH || /[\r\n]/.test(note)) {
    return { ok: false, field: 'note' }
  }
  let unitCostCents: number | undefined
  if (canSetCost && values.action !== StockActions.REMOVE && values.unitCost.trim() !== '') {
    const cents = parseCents(values.unitCost)
    if (cents === null || cents > ProductLimits.MAX_AMOUNT_CENTS)
      return { ok: false, field: 'unitCost' }
    unitCostCents = cents
  }
  return {
    ok: true,
    value: {
      warehouseId: values.warehouseId,
      productId: product.id,
      ...(values.variantId === '' ? {} : { variantId: values.variantId }),
      type: TYPE_OF[values.action],
      quantity,
      reason: values.reason,
      ...(note === '' ? {} : { note }),
      ...(unitCostCents === undefined ? {} : { unitCostCents })
    }
  }
}

// The sign a movement shows in the kardex: units in are positive, units out negative, and a reservation is neither (the
// table of what each type does to the level is the one of the engine)
export function signedQuantity(type: string, quantity: number): number {
  if (!isMovementType(type)) return 0
  return InventoryMovementEffects[type].onHand * quantity
}

export const MOVEMENT_TYPES = Object.values(InventoryMovementType)

export const isMovementType = (type: string): type is InventoryMovementType =>
  (MOVEMENT_TYPES as readonly string[]).includes(type)

export const isAdjustmentReason = (reason: string): reason is InventoryAdjustmentReason =>
  (Object.values(InventoryAdjustmentReason) as string[]).includes(reason)
