import type { PrismaTransaction } from '@platform/core/database'
import {
  computeOrderTotals,
  evaluatePriceControl,
  isFreeShippingOrder,
  isShippingFeeWithinRange,
  normalizeNote,
  OrderConflicts,
  PriceApprovalStatus,
  CarrierConnectionStatus,
  ShippingFeeBoundKinds,
  type ShippingFeeBounds,
  type OrderTotals,
  type PriceControlResult
} from '@platform/core/domain'
import { ErrorCodes, resourceConflict, resourceNotFound } from '@platform/core/errors'
import type { OrderPreferences } from '@platform/core/store-preferences'

import { orderRefusal } from './orders.support'

// What an order costs, decided on the server from the catalog and the rules of TDD_17 §4.13. Nothing here trusts a
// client number: the unit price of a line is the catalog's unless a member with ORDERS_OVERRIDE_PRICE names another with
// its reason, and every total is computed (libs/core/domain/order-rules.ts), never read from the request.

export interface OrderLine {
  productId: string
  variantId: string | null
  productName: string
  variantName: string | null
  quantity: number
  unitPriceCents: number
  // Null unless the price was overridden: then the catalog price the line had
  originalUnitPriceCents: number | null
  priceOverrideReason: string | null
  // Who set the price: kept when the line is kept, so an edit of the quantities does not take the credit
  priceOverriddenBy: string | null
  // Snapshot of Product.freeShipping at the moment of the order
  freeShipping: boolean
  trackInventory: boolean
  // The warehouses the agent chose for the units of this line in THIS request (never stored on the line)
  requestedAllocations?: readonly { warehouseId: string; quantity: number }[] | undefined
  // Where this line's units were before an edit that did not touch it: kept when they still can be served, otherwise
  // the line is planned again (a soft wish, never an error)
  preferredAllocations?: readonly { warehouseId: string; quantity: number }[] | undefined
}

export interface LineRequest {
  productId: string
  variantId?: string | undefined
  quantity: number
  unitPriceCents?: number | undefined
  priceReason?: string | null | undefined
  allocations?: readonly { warehouseId: string; quantity: number }[] | undefined
}

// The lines of a request, read from the catalog of the store. A product or variant of another store is one that does not
// exist; one that is switched off is not for sale; a product with variants is sold by variant.
export async function resolveLines(
  tx: PrismaTransaction,
  storeId: string,
  requests: readonly LineRequest[],
  who: {
    userId: string
    canOverridePrice: boolean
    // The lines the order has now, on an edit: a line that names no price (or names the one it has) and is already there
    // keeps the price it was made at (what the customer was told, an override included), not today's catalog price
    existing?: readonly OrderLine[]
  }
): Promise<{ lines: OrderLine[]; priceChanged: boolean }> {
  const products = await tx.product.findMany({
    where: { storeId, id: { in: requests.map(request => request.productId) } },
    select: {
      id: true,
      name: true,
      priceCents: true,
      active: true,
      freeShipping: true,
      trackInventory: true,
      variants: { select: { id: true, name: true, priceCents: true, active: true } }
    }
  })
  let priceChanged = false
  const lines = requests.map((request): OrderLine => {
    const product = products.find(row => row.id === request.productId)
    if (product === undefined) throw resourceNotFound('product')
    if (!product.active) {
      throw resourceConflict('the product is switched off', {
        conflict: OrderConflicts.PRODUCT_INACTIVE,
        productId: product.id
      })
    }
    const variant =
      request.variantId === undefined
        ? null
        : (product.variants.find(row => row.id === request.variantId) ?? null)
    if (request.variantId !== undefined && variant === null) throw resourceNotFound('variant')
    if (variant !== null && !variant.active) {
      throw resourceConflict('the variant is switched off', {
        conflict: OrderConflicts.VARIANT_INACTIVE,
        productId: product.id,
        variantId: variant.id
      })
    }
    if (variant === null && product.variants.some(row => row.active)) {
      throw resourceConflict('the product has variants: name the one that is sold', {
        conflict: OrderConflicts.VARIANT_REQUIRED,
        productId: product.id
      })
    }
    const before = (who.existing ?? []).find(
      line => line.productId === product.id && line.variantId === (variant?.id ?? null)
    )
    // A client that echoes the price the line has is not naming a new one
    const keeps =
      before !== undefined &&
      (request.unitPriceCents === undefined || request.unitPriceCents === before.unitPriceCents) &&
      (request.priceReason === undefined ||
        normalizeNote(request.priceReason) === before.priceOverrideReason)
    if (keeps) {
      // An override was agreed for the quantity it was made for: selling more at that price is a new price decision
      if (
        before.originalUnitPriceCents !== null &&
        request.quantity > before.quantity &&
        !who.canOverridePrice
      ) {
        throw orderRefusal(ErrorCodes.ORDER_PRICE_OVERRIDE_FORBIDDEN)
      }
      return {
        ...before,
        quantity: request.quantity,
        trackInventory: product.trackInventory,
        requestedAllocations: request.allocations
      }
    }
    // A variant with no price of its own sells at the price of its product
    const catalogCents = variant?.priceCents ?? product.priceCents
    const overridden =
      request.unitPriceCents !== undefined && request.unitPriceCents !== catalogCents
    const reason = normalizeNote(request.priceReason)
    if (overridden && reason === null) throw orderRefusal(ErrorCodes.ORDER_PRICE_REASON_REQUIRED)
    if (overridden) priceChanged = true
    return {
      productId: product.id,
      variantId: variant?.id ?? null,
      productName: product.name,
      variantName: variant?.name ?? null,
      quantity: request.quantity,
      unitPriceCents: overridden ? (request.unitPriceCents as number) : catalogCents,
      originalUnitPriceCents: overridden ? catalogCents : null,
      priceOverrideReason: overridden ? reason : null,
      priceOverriddenBy: overridden ? who.userId : null,
      freeShipping: product.freeShipping,
      trackInventory: product.trackInventory,
      requestedAllocations: request.allocations
    }
  })
  return { lines, priceChanged }
}

export interface PricingInput {
  lines: readonly OrderLine[]
  shippingCents: number
  discountCents: number
  discountReason: string | null | undefined
  // A line was priced differently from the catalog by THIS request (a stored override is not a new one)
  linePriceChanged: boolean
  canOverridePrice: boolean
  preferences: OrderPreferences
  approvalStatus: PriceApprovalStatus
  approved: { discountCents: number | null; shippingCents: number | null } | null
  // See PriceControlInput: the discount and the fee are the ones the order had, on the same lines
  discountUnchanged?: boolean
  feeUnchanged?: boolean
  // The range the fee is judged against: the planned carrier's, none, or unmanaged (see planCarrier)
  feeBounds: ShippingFeeBounds
}

export interface Pricing {
  totals: OrderTotals
  freeShipping: boolean
  control: Extract<PriceControlResult, { ok: true }>
}

// The totals, the free-shipping flag and the three levels of price control for one state of an order. A refusal of any
// rule is thrown with its own code.
export function priceOrder(input: PricingInput): Pricing {
  const totals = computeOrderTotals({
    lines: input.lines,
    shippingCents: input.shippingCents,
    discountCents: input.discountCents
  })
  if (!totals.ok) throw orderRefusal(totals.code)
  const freeShipping = isFreeShippingOrder(input.lines, input.preferences.freeShippingRule)
  const feeWithinRange = isShippingFeeWithinRange(
    input.shippingCents,
    freeShipping,
    input.feeBounds
  )
  // A discount or a fee out of its range has its own reason: the reason of a changed line price is not a substitute
  const sanctioned = input.approvalStatus === PriceApprovalStatus.NOT_REQUIRED
  // A discount always keeps its reason: an edit of something else cannot clear it with the reason of a line in its place
  if (input.discountCents > 0 && normalizeNote(input.discountReason) === null) {
    throw orderRefusal(ErrorCodes.ORDER_PRICE_REASON_REQUIRED)
  }
  const needsOwnReason =
    (input.discountCents > 0 && !(sanctioned && input.discountUnchanged === true)) ||
    (!feeWithinRange && !(sanctioned && input.feeUnchanged === true))
  if (needsOwnReason && normalizeNote(input.discountReason) === null) {
    throw orderRefusal(ErrorCodes.ORDER_PRICE_REASON_REQUIRED)
  }
  const lineReason = input.lines.find(
    line => line.priceOverrideReason !== null
  )?.priceOverrideReason
  const control = evaluatePriceControl({
    canOverridePrice: input.canOverridePrice,
    linePriceChanged: input.linePriceChanged,
    discountCents: totals.discountCents,
    shippingCents: totals.shippingCents,
    subtotalCents: totals.subtotalCents,
    discountLimitPercent: input.preferences.discountLimitPercent,
    feeWithinRange,
    approvalStatus: input.approvalStatus,
    reason: input.discountReason ?? lineReason,
    approved: input.approved,
    ...(input.discountUnchanged === undefined
      ? {}
      : { discountUnchanged: input.discountUnchanged }),
    ...(input.feeUnchanged === undefined ? {} : { feeUnchanged: input.feeUnchanged })
  })
  if (!control.ok) throw orderRefusal(control.code)
  return { totals, freeShipping, control }
}

export const approvalColumnsCleared = {
  priceApprovedBy: null,
  priceApprovedAt: null,
  priceApprovedDiscountCents: null,
  priceApprovedShippingCents: null
} as const

// The planned carrier of an order and the range its fee is judged against (TDD_17 §4.13). `requested` is what the request
// names: a connection, null for none, or undefined for "as the store has it" (its default connection, on a new order).
// A connection of another store does not exist and one that was disconnected cannot be planned. An order with no carrier
// must charge no fee, but only once the store has a carrier at all: until its first connection the fee is limited only by
// the free-shipping rule, so a store that has not set carriers up is not stopped from charging a fee (the carriers are
// configured in Settings, Step 4.14).
export interface PlannedCarrier {
  connectionId: string | null
  bounds: ShippingFeeBounds
}

export async function planCarrier(
  tx: PrismaTransaction,
  storeId: string,
  requested: string | null | undefined,
  useStoreDefault: boolean
): Promise<PlannedCarrier> {
  let connectionId: string | null = requested ?? null
  if (requested === undefined && useStoreDefault) {
    const settings = await tx.storeSettings.findUnique({
      where: { storeId },
      select: { defaultCarrierConnectionId: true }
    })
    connectionId = settings?.defaultCarrierConnectionId ?? null
    // A default that was disconnected is no longer a carrier to plan with
    if (connectionId !== null) {
      const live = await tx.carrierConnection.count({
        where: { id: connectionId, storeId, status: CarrierConnectionStatus.ACTIVE }
      })
      if (live === 0) connectionId = null
    }
  }
  if (connectionId !== null) {
    const row = await tx.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: { status: true, minShippingFeeCents: true, maxShippingFeeCents: true }
    })
    if (row === null) throw resourceNotFound('carrier')
    if (row.status !== String(CarrierConnectionStatus.ACTIVE)) {
      throw orderRefusal(ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE)
    }
    return {
      connectionId,
      bounds: {
        kind: ShippingFeeBoundKinds.CARRIER,
        minCents: row.minShippingFeeCents,
        maxCents: row.maxShippingFeeCents
      }
    }
  }
  const carriers = await tx.carrierConnection.count({
    where: { storeId, status: CarrierConnectionStatus.ACTIVE }
  })
  return {
    connectionId: null,
    bounds: {
      kind: carriers === 0 ? ShippingFeeBoundKinds.UNMANAGED : ShippingFeeBoundKinds.NO_CARRIER
    }
  }
}
