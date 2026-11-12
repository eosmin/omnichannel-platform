import { ErrorCodes, type ErrorCode } from './errors/error-codes'
import { OrderReturnStatusTransitions } from './shipping-constants'
import {
  InventoryAdjustmentReason,
  InventoryMovementType,
  OrderReturnCondition,
  OrderReturnStatus,
  OrderStatus,
  ShipmentStatus
} from './status-enums'

// The pure rules of a return (TDD_17 §4.11): what may be returned, how much, what a receipt does to the stock and when the
// order is returned as a whole. Nothing here reads or writes anything; `ReturnsService` calls it inside its transactions.

export type ReturnVerdict = { readonly ok: true } | { readonly ok: false; readonly code: ErrorCode }

const OK: ReturnVerdict = { ok: true }
const refuse = (code: ErrorCode): ReturnVerdict => ({ ok: false, code })

// The returns that no longer hold goods: they never count against what can still be returned
const STATUSES_THAT_RELEASE_UNITS: readonly OrderReturnStatus[] = [
  OrderReturnStatus.REJECTED,
  OrderReturnStatus.CANCELLED
]

// The returns whose goods are back: what the order has really received
const STATUSES_THAT_HAVE_RECEIVED: readonly OrderReturnStatus[] = [
  OrderReturnStatus.RECEIVED,
  OrderReturnStatus.COMPLETED
]

export const holdsUnits = (status: OrderReturnStatus): boolean =>
  !STATUSES_THAT_RELEASE_UNITS.includes(status)

export const hasReceivedUnits = (status: OrderReturnStatus): boolean =>
  STATUSES_THAT_HAVE_RECEIVED.includes(status)

export function canMoveReturn(from: OrderReturnStatus, to: OrderReturnStatus): boolean {
  return OrderReturnStatusTransitions[from].includes(to)
}

// A return starts on a delivered order, or on one that is on its way back: shipped, with a guide the carrier is bringing
// back (`returning`) or already brought back (`returned`)
export function checkReturnableOrder(input: {
  orderStatus: OrderStatus
  outboundStatuses: readonly ShipmentStatus[]
}): ReturnVerdict {
  if (input.orderStatus === OrderStatus.DELIVERED) return OK
  if (
    input.orderStatus === OrderStatus.SHIPPED &&
    input.outboundStatuses.some(
      status => status === ShipmentStatus.RETURNING || status === ShipmentStatus.RETURNED
    )
  ) {
    return OK
  }
  return refuse(ErrorCodes.RETURN_ORDER_NOT_DELIVERED)
}

export interface ReturnableItem {
  id: string
  quantity: number
}

export interface ReturnLineRequest {
  orderItemId: string
  quantity: number
}

export interface ReturnLineLike {
  orderItemId: string
  quantity: number
}

// What the returns that hold units already take of each item
export function unitsHeld(
  returns: readonly { status: OrderReturnStatus; lines: readonly ReturnLineLike[] }[]
): Map<string, number> {
  const held = new Map<string, number>()
  for (const entry of returns) {
    if (!holdsUnits(entry.status)) continue
    for (const line of entry.lines) {
      held.set(line.orderItemId, (held.get(line.orderItemId) ?? 0) + line.quantity)
    }
  }
  return held
}

export type LinePlanVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly orderItemId: string }

// Every line names an item of the order once, and asks for no more than the item has left (what was delivered minus what the
// returns that still hold units take). A quantity above that is `RETURN_QUANTITY_EXCEEDS_DELIVERED`; an item that is not
// of the order, a repeated one or a quantity below one is a bad request the caller answers as such.
export function checkReturnLines(input: {
  items: readonly ReturnableItem[]
  held: ReadonlyMap<string, number>
  lines: readonly ReturnLineRequest[]
}): LinePlanVerdict {
  const byId = new Map(input.items.map(item => [item.id, item]))
  const seen = new Set<string>()
  for (const line of input.lines) {
    const item = byId.get(line.orderItemId)
    if (item === undefined || seen.has(line.orderItemId) || line.quantity < 1) {
      return { ok: false, code: ErrorCodes.VALIDATION_INVALID_INPUT, orderItemId: line.orderItemId }
    }
    seen.add(line.orderItemId)
    const left = item.quantity - (input.held.get(item.id) ?? 0)
    if (line.quantity > left) {
      return {
        ok: false,
        code: ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED,
        orderItemId: line.orderItemId
      }
    }
  }
  return { ok: true }
}

// The order is returned when the returns that are back cover every unit of every item; a part leaves it delivered
export function coversEveryUnit(
  items: readonly ReturnableItem[],
  returns: readonly { status: OrderReturnStatus; lines: readonly ReturnLineLike[] }[]
): boolean {
  if (items.length === 0) return false
  const back = new Map<string, number>()
  for (const entry of returns) {
    if (!hasReceivedUnits(entry.status)) continue
    for (const line of entry.lines) {
      back.set(line.orderItemId, (back.get(line.orderItemId) ?? 0) + line.quantity)
    }
  }
  return items.every(item => (back.get(item.id) ?? 0) >= item.quantity)
}

export interface ReturnMovementStep {
  // The part of the key that says which movement of the receipt this is (`return:{returnId}:{orderItemId}:{movement}`)
  movement: string
  type: InventoryMovementType
  reason: InventoryAdjustmentReason | null
}

export const ReturnMovements = {
  RETURN_IN: 'return_in',
  DISCARD: 'discard'
} as const

// What a receipt does to the stock of one line (TDD_17 §4.11). A resellable unit is added back. A defective or damaged one is
// added and discarded at once, so the append-only ledger shows that it came back and was thrown away and the net stock does
// not change; either way the units are counted in once.
export function movementsOfReceipt(condition: OrderReturnCondition): readonly ReturnMovementStep[] {
  const back: ReturnMovementStep = {
    movement: ReturnMovements.RETURN_IN,
    type: InventoryMovementType.RETURN_IN,
    reason: null
  }
  if (condition === OrderReturnCondition.RESELLABLE) return [back]
  return [
    back,
    {
      movement: ReturnMovements.DISCARD,
      type: InventoryMovementType.ADJUSTMENT_OUT,
      reason: InventoryAdjustmentReason.DAMAGED
    }
  ]
}

// The key a movement of a receipt carries, so that a retry of the same receipt applies it once (TDD_16 §4.2)
export function returnMovementKey(returnId: string, orderItemId: string, movement: string): string {
  return `return:${returnId}:${orderItemId}:${movement}`
}

// The warehouse an item goes back to when nobody chose one: the one that sent most of it (ties: the smaller id, so the answer
// does not depend on the order the rows were read in)
export function defaultRestockWarehouse(
  allocations: readonly { warehouseId: string; quantity: number }[]
): string | null {
  let best: { warehouseId: string; quantity: number } | null = null
  for (const allocation of allocations) {
    if (
      best === null ||
      allocation.quantity > best.quantity ||
      (allocation.quantity === best.quantity && allocation.warehouseId < best.warehouseId)
    ) {
      best = allocation
    }
  }
  return best === null ? null : best.warehouseId
}

// The money given back never passes what the customer paid: what the other returns of the order already refunded counts
export function refundRoom(input: {
  orderTotalCents: number
  alreadyRefundedCents: number
}): number {
  return Math.max(0, input.orderTotalCents - input.alreadyRefundedCents)
}

// ---------------------------------------------------------------- exchange credit (TDD_17 §4.11)

// What the returned units are worth: the price each unit was sold at (an override included), times the units that come back
export function exchangeCreditCents(
  lines: readonly { unitPriceCents: number; quantity: number }[]
): number {
  return lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
}

// The credit goes against the products of the replacement and never against its shipping fee (an order's discount cannot pass its
// subtotal), so the total is the price difference: `max(0, replacement value - credit)` plus the fee. What the credit has left over
// is what the owner settles with the customer by hand (a refund).
export function applyExchangeCredit(input: { subtotalCents: number; creditCents: number }): {
  discountCents: number
  excessCents: number
} {
  const discountCents = Math.min(input.subtotalCents, input.creditCents)
  return { discountCents, excessCents: input.creditCents - discountCents }
}

// The reason the replacement order keeps for its credit: it names the return that made it, so it is told apart from a discount an
// agent typed (which has a limit and an approval)
export const EXCHANGE_CREDIT_REASON_PREFIX = 'exchange_credit:'
export const exchangeCreditReason = (returnId: string): string =>
  `${EXCHANGE_CREDIT_REASON_PREFIX}${returnId}`
