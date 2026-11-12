import {
  type ApproveReturnBody,
  canMoveReturn,
  checkReturnableOrder,
  type CompleteReturnBody,
  type CreateReturnBody,
  OrderReturnCondition,
  OrderReturnStatus,
  OrderLimits,
  OrderReturnType,
  OrderStatus,
  type OrderReturnReasonKey,
  OrderReturnReasonKeys,
  type ReceiveReturnBody,
  type PaymentMethod,
  ReturnLimits,
  ShipmentStatus,
  type ShippingPayer,
  unitsHeld
} from '@platform/core/domain'

import { parseCents } from '../products/money'

import { asOrderStatus } from './order-detail-rules'
import { addressBody, readAddress } from './order-fields'

// What the Returns panel of the order detail offers. The api decides every move (`canMoveReturn` is its own table, the one used
// here); the panel only draws what the return accepts in its status and what the member holds.

export const ReturnActions = {
  APPROVE: 'approve',
  REJECT: 'reject',
  CANCEL: 'cancel',
  IN_TRANSIT: 'in_transit',
  RECEIVE: 'receive',
  COMPLETE: 'complete',
  RETURN_GUIDE: 'return_guide'
} as const
export type ReturnAction = (typeof ReturnActions)[keyof typeof ReturnActions]

const TARGET_OF: Record<Exclude<ReturnAction, 'return_guide'>, OrderReturnStatus> = {
  [ReturnActions.APPROVE]: OrderReturnStatus.APPROVED,
  [ReturnActions.REJECT]: OrderReturnStatus.REJECTED,
  [ReturnActions.CANCEL]: OrderReturnStatus.CANCELLED,
  [ReturnActions.IN_TRANSIT]: OrderReturnStatus.IN_TRANSIT,
  [ReturnActions.RECEIVE]: OrderReturnStatus.RECEIVED,
  [ReturnActions.COMPLETE]: OrderReturnStatus.COMPLETED
}

const ORDER_OF_ACTIONS: readonly ReturnAction[] = [
  ReturnActions.APPROVE,
  ReturnActions.IN_TRANSIT,
  ReturnActions.RECEIVE,
  ReturnActions.COMPLETE,
  ReturnActions.RETURN_GUIDE,
  ReturnActions.REJECT,
  ReturnActions.CANCEL
]

// The moves of a return that its status allows and the member may make (`returns:manage` owns every one). The guide of the way
// back is offered to an approved return that has none yet, when a connection of the store can make one.
export function offeredReturnActions(input: {
  status: OrderReturnStatus
  returnShipmentId: string | null
  mayManage: boolean
  canMakeReturnGuide: boolean
}): ReturnAction[] {
  if (!input.mayManage) return []
  return ORDER_OF_ACTIONS.filter(action => {
    if (action === ReturnActions.RETURN_GUIDE) {
      return (
        input.canMakeReturnGuide &&
        input.returnShipmentId === null &&
        input.status === OrderReturnStatus.APPROVED
      )
    }
    return canMoveReturn(input.status, TARGET_OF[action])
  })
}

const KNOWN_RETURN_STATUSES: readonly string[] = Object.values(OrderReturnStatus)

export const asReturnStatus = (value: string): OrderReturnStatus | null =>
  KNOWN_RETURN_STATUSES.includes(value) ? (value as OrderReturnStatus) : null

export const asReturnReasonKey = (value: string): OrderReturnReasonKey | null =>
  OrderReturnReasonKeys.find(known => known === value) ?? null

interface ItemLike {
  id: string
  quantity: number
}

interface ReturnLike {
  status: OrderReturnStatus
  lines: readonly { orderItemId: string; quantity: number }[]
}

// What each item of the order can still send back: what was bought less what the returns that still hold units take
export function remainingUnits(
  items: readonly ItemLike[],
  returns: readonly ReturnLike[]
): Map<string, number> {
  const held = unitsHeld(returns)
  return new Map(
    items.map(item => [item.id, Math.max(0, item.quantity - (held.get(item.id) ?? 0))])
  )
}

// A return starts on a delivered order or on one that is on its way back, and only while some unit is left (the api's own rule)
export function canStartReturn(input: {
  orderStatus: string
  // Null while the guides are not known (loading, failed, or the member may not read them): the api then decides for a shipped order
  outboundStatuses: readonly string[] | null
  items: readonly ItemLike[]
  returns: readonly ReturnLike[]
}): boolean {
  const status = asOrderStatus(input.orderStatus)
  if (status === null) return false
  if (input.outboundStatuses === null) {
    // A delivered order is returnable whatever its guides say; a shipped one depends on them, which the api reads
    const maybe = status === OrderStatus.DELIVERED || status === OrderStatus.SHIPPED
    if (!maybe) return false
  } else {
    const known = input.outboundStatuses
    const outbound = Object.values(ShipmentStatus).filter(value => known.includes(value))
    if (!checkReturnableOrder({ orderStatus: status, outboundStatuses: outbound }).ok) return false
  }
  return [...remainingUnits(input.items, input.returns).values()].some(left => left > 0)
}

// ------------------------------------------------------------------------------------------------------------- create

export interface CreateReturnDraft {
  type: OrderReturnType
  reason: OrderReturnReasonKey | ''
  // '' = the default of the store
  payer: ShippingPayer | ''
  notes: string
  // Units per item, as typed; an empty text is none
  quantities: Record<string, string>
}

export const EMPTY_RETURN_DRAFT: CreateReturnDraft = {
  type: OrderReturnType.REFUND,
  reason: '',
  payer: '',
  notes: '',
  quantities: {}
}

// The units of a line as a whole number inside what is left, or null when the text is anything else (an empty text is zero units)
export function unitsOf(text: string, left: number): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value <= Math.min(left, ReturnLimits.MAX_LINE_QUANTITY) ? value : null
}

export function createReturnBody(
  orderId: string,
  draft: CreateReturnDraft,
  left: ReadonlyMap<string, number>
): CreateReturnBody | null {
  if (draft.reason === '') return null
  const lines: { orderItemId: string; quantity: number }[] = []
  for (const [orderItemId, available] of left) {
    const units = unitsOf(draft.quantities[orderItemId] ?? '', available)
    if (units === null) return null
    if (units > 0) lines.push({ orderItemId, quantity: units })
  }
  if (lines.length === 0) return null
  const notes = draft.notes.trim()
  return {
    orderId,
    type: draft.type,
    reason: draft.reason,
    lines,
    ...(draft.payer === '' ? {} : { shippingPayer: draft.payer }),
    ...(notes === '' ? {} : { notes })
  }
}

// ------------------------------------------------------------------------------------------------------------- approve

export interface ReplacementLineDraft {
  key: string
  productId: string
  variantId: string | null
  productName: string
  variantName: string | null
  quantity: string
}

export interface ReplacementDraft {
  lines: ReplacementLineDraft[]
  shipping: string
}

interface OrderForReplacement {
  paymentMethod: string
  shippingAddress: unknown
  recipientPhones: readonly string[]
}

// An exchange is approved with the order that replaces it. The customer, the way it is paid and where it goes are those of the
// returned order (the agent can change them on the replacement afterwards); the agent picks the products and the shipping fee.
// Null while a line has no whole quantity or the order has no address to copy where one is needed.
export function approveBody(
  type: OrderReturnType,
  draft: ReplacementDraft,
  order: OrderForReplacement
): ApproveReturnBody | null {
  if (type === OrderReturnType.REFUND) return {}
  if (draft.lines.length === 0) return null
  const items: { productId: string; variantId?: string; quantity: number }[] = []
  for (const line of draft.lines) {
    const quantity = /^\d{1,5}$/.test(line.quantity.trim()) ? Number(line.quantity) : 0
    if (quantity < 1 || quantity > OrderLimits.MAX_QUANTITY_PER_LINE) return null
    items.push({
      productId: line.productId,
      ...(line.variantId === null ? {} : { variantId: line.variantId }),
      quantity
    })
  }
  const fee = draft.shipping.trim() === '' ? 0 : parseCents(draft.shipping)
  if (fee === null) return null
  const fields = readAddress(order.shippingAddress)
  const address = fields === null ? null : addressBody(fields)
  return {
    replacement: {
      items,
      shippingCents: fee,
      scheduledDeliveryDate: null,
      paymentMethod: order.paymentMethod as PaymentMethod,
      recipientPhones: [...order.recipientPhones],
      ...(address === null ? {} : { shippingAddress: address })
    }
  }
}

// ------------------------------------------------------------------------------------------------------------- receive

export interface ReceiveLineDraft {
  condition: OrderReturnCondition | ''
  warehouseId: string
}

// Nothing is assumed resellable: every line names its condition. A warehouse is asked only for a resellable line and may be left
// to the server (the one that sent most of the units).
export function receiveBody(
  lines: readonly { orderItemId: string }[],
  draft: Readonly<Record<string, ReceiveLineDraft>>
): ReceiveReturnBody | null {
  const out: ReceiveReturnBody['lines'] = []
  for (const line of lines) {
    const entry = draft[line.orderItemId]
    if (entry === undefined || entry.condition === '') return null
    out.push({
      orderItemId: line.orderItemId,
      condition: entry.condition,
      ...(entry.condition === OrderReturnCondition.RESELLABLE && entry.warehouseId !== ''
        ? { restockWarehouseId: entry.warehouseId }
        : {})
    })
  }
  return out.length === 0 ? null : { lines: out }
}

// ------------------------------------------------------------------------------------------------------------- complete

// A refund records the money given back by hand (empty = none recorded); an exchange has none. Null for an amount that is not money.
export function completeBody(
  type: OrderReturnType,
  amount: string,
  notes: string
): CompleteReturnBody | null {
  const text = notes.trim()
  const extra = text === '' ? {} : { notes: text }
  if (type !== OrderReturnType.REFUND || amount.trim() === '') return extra
  const cents = parseCents(amount)
  return cents === null ? null : { refundAmountCents: cents, ...extra }
}
