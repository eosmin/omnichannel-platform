import type { OrderDetailView } from '@platform/api-client'
import type { Permission } from '@platform/core/auth'
import { PaymentStatus, type UpdateOrderInput } from '@platform/core/domain'

import { centsToInput, parseCents } from '../products/money'

import { canEditField } from './order-detail-rules'
import {
  allocationProblem,
  chosenAllocations,
  type DraftLine,
  type FormField,
  lineKey,
  parseQuantity,
  type StockRules
} from './order-form'

// The edit-order drawer: what an existing order is changed to (its items, its shipping fee and its discount; the day, the
// address, the phones, the notes and the payment are edited on the detail page). The server prices the result: only what
// changed is sent, never a total.

export interface EditDraft {
  lines: DraftLine[]
  shippingText: string
  discountText: string
  discountReason: string
}

// The lines as the order has them. The price shown is the one the line was sold at (an override included, with its reason);
// the "catalog price" of a line is the one it had before the override, so that taking the price back to it needs no reason.
export function draftFromOrder(order: OrderDetailView): EditDraft {
  return {
    lines: order.items.map(item => ({
      key: lineKey(item.productId, item.variantId),
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      variantName: item.variantName,
      sku: null,
      catalogPriceCents: item.originalUnitPriceCents ?? item.unitPriceCents,
      soldPriceCents: item.unitPriceCents,
      quantity: String(item.quantity),
      priceText: centsToInput(item.unitPriceCents),
      priceReason: item.priceOverrideReason ?? '',
      allocations: null
    })),
    shippingText: centsToInput(order.shippingCents),
    discountText: centsToInput(order.discountCents),
    discountReason: order.discountReason ?? ''
  }
}

// The units each existing line holds in each warehouse, by the key of the line: an edit gives them back before it plans again
export function releasedOf(
  order: OrderDetailView
): Map<string, readonly { warehouseId: string; quantity: number }[]> {
  return new Map(
    order.items.map(item => [lineKey(item.productId, item.variantId), item.allocations])
  )
}

export interface EditableParts {
  items: boolean
  shipping: boolean
  discount: boolean
}

// Which of the three the order accepts now: the status table, the permission to edit, and the payment (once a payment is
// COMPLETED the items, the fee and the discount are fixed: refund it and the order is open again, as the api checks)
export function editablePartsOf(
  order: Pick<OrderDetailView, 'status' | 'paymentStatus'>,
  can: (permission: Permission) => boolean
): EditableParts {
  const isPaid = order.paymentStatus === (PaymentStatus.COMPLETED as string)
  return {
    items: !isPaid && canEditField(order.status, 'items', can),
    shipping: !isPaid && canEditField(order.status, 'shipping', can),
    discount: !isPaid && canEditField(order.status, 'discount', can)
  }
}

export type UpdateResult =
  { ok: true; value: UpdateOrderInput } | { ok: false; field: FormField; line?: string }

// The body of PATCH /orders/:id with only what changed, or the first field that is wrong. `canOverridePrice` is
// ORDERS_OVERRIDE_PRICE: without it a line is sent with no price (the server keeps the one it has).
export function buildUpdate(
  draft: EditDraft,
  order: OrderDetailView,
  editable: EditableParts,
  allowed: { canOverridePrice: boolean },
  stock: ReadonlyMap<string, StockRules>
): UpdateResult {
  const body: UpdateOrderInput = {}

  if (editable.items) {
    if (draft.lines.length === 0) return { ok: false, field: 'lines' }
    const before = new Map(order.items.map(item => [lineKey(item.productId, item.variantId), item]))
    const items: NonNullable<UpdateOrderInput['items']> = []
    let changed = draft.lines.length !== order.items.length
    for (const line of draft.lines) {
      const quantity = parseQuantity(line.quantity)
      if (quantity === null) return { ok: false, field: 'quantity', line: line.key }
      const old = before.get(line.key)
      if (old === undefined || old.quantity !== quantity) changed = true
      let unitPriceCents: number | undefined
      let priceReason: string | undefined
      if (allowed.canOverridePrice && line.priceText !== null) {
        const cents = parseCents(line.priceText)
        if (cents === null) return { ok: false, field: 'price', line: line.key }
        const sold = old?.unitPriceCents ?? line.catalogPriceCents
        const reason = line.priceReason.trim()
        // A new price, or a new reason for the override the line already has
        if (
          cents !== sold ||
          (cents !== line.catalogPriceCents && reason !== (old?.priceOverrideReason ?? ''))
        ) {
          if (cents !== line.catalogPriceCents && reason === '') {
            return { ok: false, field: 'priceReason', line: line.key }
          }
          unitPriceCents = cents
          priceReason = cents === line.catalogPriceCents ? undefined : reason
          changed = true
        }
      }
      const chosen = chosenAllocations(line)
      if (chosen !== null) {
        const rules = stock.get(line.key)
        if (rules === undefined || allocationProblem(line, rules) !== null) {
          return { ok: false, field: 'allocations', line: line.key }
        }
        changed = true
      }
      items.push({
        productId: line.productId,
        ...(line.variantId === null ? {} : { variantId: line.variantId }),
        quantity,
        ...(unitPriceCents === undefined ? {} : { unitPriceCents }),
        ...(priceReason === undefined ? {} : { priceReason }),
        ...(chosen === null ? {} : { allocations: chosen })
      })
    }
    if (changed) body.items = items
  }

  if (editable.shipping) {
    const cents = draft.shippingText.trim() === '' ? 0 : parseCents(draft.shippingText)
    if (cents === null) return { ok: false, field: 'shipping' }
    if (cents !== order.shippingCents) body.shippingCents = cents
  }

  if (editable.discount) {
    const cents = draft.discountText.trim() === '' ? 0 : parseCents(draft.discountText)
    if (cents === null) return { ok: false, field: 'discount' }
    const reason = draft.discountReason.trim()
    if (cents > 0 && reason === '') return { ok: false, field: 'discountReason' }
    const reasonChanged = reason !== (order.discountReason ?? '')
    // The one reason field also carries the reason of a shipping fee outside its range: a reason typed next to a new fee
    // travels with it even when the discount stays at 0
    const travelsWithPrice = body.shippingCents !== undefined || body.items !== undefined
    if (cents !== order.discountCents || (cents > 0 && reasonChanged)) {
      body.discountCents = cents
      // A discount taken back loses its reason with it, unless the same request needs one for the fee
      body.discountReason = cents > 0 || (travelsWithPrice && reason !== '') ? reason : null
    } else if (reasonChanged && travelsWithPrice) {
      body.discountReason = reason === '' ? null : reason
    }
  }

  if (Object.keys(body).length === 0) return { ok: false, field: 'nothing' }
  return { ok: true, value: body }
}
