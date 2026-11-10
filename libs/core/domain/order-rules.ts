import { ErrorCodes, type ErrorCode } from './errors/error-codes'
import {
  ORDER_MAX_AMOUNT_CENTS,
  OrderFreeShippingRules,
  OrderLimits,
  PackingNoteNotice,
  type OrderFreeShippingRule
} from './order-constants'
import { PriceApprovalTransitions } from './shipping-constants'
import {
  OrderEditableFields,
  OrderStatus,
  OrderStatusTransitions,
  PaymentMethod,
  PaymentStatus,
  PaymentStatusTransitions,
  PriceApprovalStatus,
  type OrderEditableField
} from './status-enums'

// The rules of an order that need no database, kept pure so the service of Step 4.3 (PR B) only reads and writes.
// Amounts are whole USD cents (TDD_02 §13); nothing here rounds, so a total is the exact sum of its parts.

type Refusal = { readonly ok: false; readonly code: ErrorCode }
type Verdict = { readonly ok: true } | Refusal

const OK = { ok: true } as const

function refuse(code: ErrorCode): Refusal {
  return { ok: false, code }
}

// Whole cents that fit the 32 bits of an Int column, which is what every amount of an order is stored in
function isCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= ORDER_MAX_AMOUNT_CENTS
}

// ---------------------------------------------------------------- state machine

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return OrderStatusTransitions[from].includes(to)
}

export function checkOrderTransition(from: OrderStatus, to: OrderStatus): Verdict {
  return canTransitionOrder(from, to) ? OK : refuse(ErrorCodes.ORDER_INVALID_STATUS_TRANSITION)
}

// The statuses a cancellation can start from are the ones whose table lists CANCELLED
export function canCancelOrder(from: OrderStatus): boolean {
  return canTransitionOrder(from, OrderStatus.CANCELLED)
}

// ---------------------------------------------------------------- editable fields

export interface EditContext {
  // trackingNumber is the carrier's while a shipment is active (TDD_17 §4.1): nobody types over it
  readonly hasActiveShipment: boolean
}

export function editableOrderFields(
  status: OrderStatus,
  { hasActiveShipment }: EditContext
): readonly OrderEditableField[] {
  const fields: readonly OrderEditableField[] = OrderEditableFields[status]
  return hasActiveShipment ? fields.filter(field => field !== 'trackingNumber') : fields
}

// The fields of a change that the status does not allow, in the order they were asked
export function lockedOrderFields(
  status: OrderStatus,
  requested: readonly OrderEditableField[],
  context: EditContext
): readonly OrderEditableField[] {
  const allowed = editableOrderFields(status, context)
  return requested.filter(field => !allowed.includes(field))
}

export function checkOrderEdit(
  status: OrderStatus,
  requested: readonly OrderEditableField[],
  context: EditContext
): Verdict {
  return lockedOrderFields(status, requested, context).length === 0
    ? OK
    : refuse(ErrorCodes.ORDER_FIELD_NOT_EDITABLE)
}

// ---------------------------------------------------------------- notes

// An empty or blank note is no note: the column holds null, so "cleared" and "never written" are one state
export function normalizeNote(value: string | null | undefined): string | null {
  const text = value?.trim() ?? ''
  return text === '' ? null : text
}

// The packing note warns the warehouse only when it really changed and the order is already waiting to be packed;
// a PENDING_CONFIRMATION order is not packed yet and a SHIPPED one has left
export function shouldWarnWarehouseOfPackingNote(
  status: OrderStatus,
  before: string | null | undefined,
  after: string | null | undefined
): boolean {
  return (
    PackingNoteNotice.STATUSES.includes(status) && normalizeNote(before) !== normalizeNote(after)
  )
}

// ---------------------------------------------------------------- totals

export interface PricedLine {
  readonly unitPriceCents: number
  readonly quantity: number
  // Snapshot of Product.freeShipping at the moment of the order (TDD_17 §4.13)
  readonly freeShipping: boolean
}

export interface OrderTotalsInput {
  readonly lines: readonly PricedLine[]
  readonly shippingCents: number
  readonly discountCents: number
}

export interface OrderTotals {
  readonly subtotalCents: number
  readonly shippingCents: number
  readonly discountCents: number
  readonly totalCents: number
}

export type OrderTotalsResult =
  ({ readonly ok: true } & OrderTotals) | { readonly ok: false; readonly code: ErrorCode }

// total = subtotal + shipping - discount, every part and every partial sum an integer that fits the 32 bits of its
// column. A part that is not a whole non-negative number of cents is a caller bug, refused like an overflow: the
// server never "fixes" money.
export function computeOrderTotals({
  lines,
  shippingCents,
  discountCents
}: OrderTotalsInput): OrderTotalsResult {
  // An order with no lines is a caller bug (the schemas ask for at least one), not an amount out of range
  if (lines.length === 0) return refuse(ErrorCodes.VALIDATION_FAILED)
  if (!isCents(shippingCents) || !isCents(discountCents)) {
    return refuse(ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE)
  }
  let subtotalCents = 0
  for (const line of lines) {
    if (
      !isCents(line.unitPriceCents) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > OrderLimits.MAX_QUANTITY_PER_LINE
    ) {
      return refuse(ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE)
    }
    // Both factors are bounded by the limits of the catalog and of the order, so the product is exact
    subtotalCents += line.unitPriceCents * line.quantity
    if (subtotalCents > ORDER_MAX_AMOUNT_CENTS) return refuse(ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE)
  }
  if (discountCents > subtotalCents) return refuse(ErrorCodes.ORDER_DISCOUNT_EXCEEDS_SUBTOTAL)
  const totalCents = subtotalCents + shippingCents - discountCents
  if (totalCents > ORDER_MAX_AMOUNT_CENTS) return refuse(ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE)
  return { ok: true, subtotalCents, shippingCents, discountCents, totalCents }
}

// ---------------------------------------------------------------- discount limit

// The discount allowed without approval to a member who lacks ORDERS_OVERRIDE_PRICE: at most `limitPercent` of the
// subtotal (TDD_17 §4.13). Compared as discount * 100 <= limit * subtotal, in whole numbers, so 10% of 333 cents is
// 33 cents and not 33.3 rounded either way.
// A limit that is not a number from 0 to 100 (a preference misread) is the strictest one, 0: it must never widen who
// skips the approval.
export function isDiscountWithinLimit(
  discountCents: number,
  subtotalCents: number,
  limitPercent: number
): boolean {
  const limit = Number.isFinite(limitPercent) && limitPercent > 0 ? Math.min(limitPercent, 100) : 0
  return discountCents * 100 <= limit * subtotalCents
}

// ---------------------------------------------------------------- free shipping

// An order is free-shipping when the store's rule is met by the snapshots of its lines (TDD_17 §4.13). An order
// with no lines is not: there is nothing that includes the shipping.
export function isFreeShippingOrder(
  lines: readonly Pick<PricedLine, 'freeShipping'>[],
  rule: OrderFreeShippingRule
): boolean {
  if (lines.length === 0) return false
  return rule === OrderFreeShippingRules.ALL_ITEMS
    ? lines.every(line => line.freeShipping)
    : lines.some(line => line.freeShipping)
}

// What the order knows about the fee it may charge. The carrier connections arrive in Step 4.8: until then every
// order is `unmanaged`, and only the free-shipping rule limits the fee.
export const ShippingFeeBoundKinds = {
  UNMANAGED: 'unmanaged',
  NO_CARRIER: 'no_carrier',
  CARRIER: 'carrier'
} as const

export type ShippingFeeBounds =
  | { readonly kind: typeof ShippingFeeBoundKinds.UNMANAGED }
  | { readonly kind: typeof ShippingFeeBoundKinds.NO_CARRIER }
  | {
      readonly kind: typeof ShippingFeeBoundKinds.CARRIER
      // Either may be empty: no bound on that side
      readonly minCents: number | null
      readonly maxCents: number | null
    }

// Is the fee charged to the customer one that needs no approval? A free-shipping order accepts 0 whatever the
// carrier's minimum and nothing else; an order with no planned carrier accepts 0 only; with a carrier the fee must be
// in its range (TDD_17 §4.13).
export function isShippingFeeWithinRange(
  feeCents: number,
  freeShipping: boolean,
  bounds: ShippingFeeBounds
): boolean {
  if (freeShipping) return feeCents === 0
  if (bounds.kind === ShippingFeeBoundKinds.UNMANAGED) return true
  if (bounds.kind === ShippingFeeBoundKinds.NO_CARRIER) return feeCents === 0
  if (bounds.minCents !== null && feeCents < bounds.minCents) return false
  if (bounds.maxCents !== null && feeCents > bounds.maxCents) return false
  return true
}

// ---------------------------------------------------------------- price control

export interface PriceControlInput {
  // The caller holds ORDERS_OVERRIDE_PRICE: level 1, which never needs approval
  readonly canOverridePrice: boolean
  // Some line was priced differently from the catalog
  readonly linePriceChanged: boolean
  readonly discountCents: number
  readonly shippingCents: number
  readonly subtotalCents: number
  // orders.discountLimitPercent of the store (0 by default)
  readonly discountLimitPercent: number
  readonly feeWithinRange: boolean
  // The current approval of the order: the values of `approved` count only while it is APPROVED (the columns of a
  // rejected request may still hold numbers)
  readonly approvalStatus: PriceApprovalStatus
  readonly reason: string | null | undefined
  // The values an approver accepted, or null when the order holds no approval
  readonly approved: {
    readonly discountCents: number | null
    readonly shippingCents: number | null
  } | null
}

export type PriceControlResult =
  | {
      readonly ok: true
      // What the order's approval status becomes with this change
      readonly approvalStatus: PriceApprovalStatus
      // The discount is over the limit or the fee out of range and the caller has no override: approvers are asked
      readonly needsApproval: boolean
      // A level 1 change is audited, and the approvers are told when orders.notifyOnPriceOverride is on
      readonly overridden: boolean
      // The order held a request or an approval (any status but NOT_REQUIRED) and this change needs none: the service
      // clears the request, audits the withdrawal and retracts the notice the approvers got
      readonly withdrawsRequest: boolean
    }
  | { readonly ok: false; readonly code: ErrorCode }

// The three levels of TDD_17 §4.13 in one place. The reason is trimmed: spaces are no reason.
export function evaluatePriceControl(input: PriceControlInput): PriceControlResult {
  if (input.linePriceChanged && !input.canOverridePrice) {
    return refuse(ErrorCodes.ORDER_PRICE_OVERRIDE_FORBIDDEN)
  }
  const discountOverLimit = !isDiscountWithinLimit(
    input.discountCents,
    input.subtotalCents,
    input.discountLimitPercent
  )
  const reasonNeeded = input.linePriceChanged || input.discountCents > 0 || !input.feeWithinRange
  if (reasonNeeded && normalizeNote(input.reason) === null) {
    return refuse(ErrorCodes.ORDER_PRICE_REASON_REQUIRED)
  }
  const overridden = input.canOverridePrice && reasonNeeded
  const needsApproval = !input.canOverridePrice && (discountOverLimit || !input.feeWithinRange)
  if (!needsApproval) {
    return {
      ok: true,
      approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
      needsApproval,
      overridden,
      withdrawsRequest: input.approvalStatus !== PriceApprovalStatus.NOT_REQUIRED
    }
  }
  // An earlier approval still holds only for the values it named: a lower or equal discount, and the same fee
  const approved = input.approvalStatus === PriceApprovalStatus.APPROVED ? input.approved : null
  const discountCovered =
    !discountOverLimit ||
    (approved !== null && input.discountCents <= (approved.discountCents ?? 0))
  const feeCovered =
    input.feeWithinRange || (approved !== null && input.shippingCents === approved.shippingCents)
  const covered = discountCovered && feeCovered
  return {
    ok: true,
    approvalStatus: covered ? PriceApprovalStatus.APPROVED : PriceApprovalStatus.PENDING,
    needsApproval,
    overridden,
    withdrawsRequest: false
  }
}

export interface PriceDecisionInput {
  readonly status: PriceApprovalStatus
  // Who asked for the approval (Order.priceApprovalRequestedBy)
  readonly requestedBy: string | null
  readonly approverId: string
  readonly decision: typeof PriceApprovalStatus.APPROVED | typeof PriceApprovalStatus.REJECTED
}

// Approve or reject a price change: it must be waiting, and nobody approves their own request. Rejecting one's own
// request is allowed: it withdraws it.
export function checkPriceDecision({
  status,
  requestedBy,
  approverId,
  decision
}: PriceDecisionInput): Verdict {
  // PENDING is decided either way; a REJECTED request can still be approved later (TDD_17 §4.13): the same table
  if (!canMovePriceApproval(status, decision)) {
    return refuse(ErrorCodes.ORDER_PRICE_APPROVAL_NOT_PENDING)
  }
  if (decision === PriceApprovalStatus.APPROVED && requestedBy === approverId) {
    return refuse(ErrorCodes.ORDER_PRICE_SELF_APPROVAL)
  }
  return OK
}

export function canMovePriceApproval(from: PriceApprovalStatus, to: PriceApprovalStatus): boolean {
  return PriceApprovalTransitions[from].includes(to)
}

// An order waiting for a price approval, or whose request was rejected, is not confirmed and gets no guide
export function isPriceApprovalBlocking(status: PriceApprovalStatus): boolean {
  return status === PriceApprovalStatus.PENDING || status === PriceApprovalStatus.REJECTED
}

// CONFIRMED is reached from PENDING_CONFIRMATION only (the state machine) and never with a price approval open
export function checkOrderConfirmation(
  status: OrderStatus,
  approval: PriceApprovalStatus
): Verdict {
  if (status === OrderStatus.CONFIRMED) return refuse(ErrorCodes.ORDER_ALREADY_CONFIRMED)
  if (!canTransitionOrder(status, OrderStatus.CONFIRMED)) {
    return refuse(ErrorCodes.ORDER_INVALID_STATUS_TRANSITION)
  }
  return isPriceApprovalBlocking(approval) ? refuse(ErrorCodes.ORDER_PRICE_APPROVAL_PENDING) : OK
}

// ---------------------------------------------------------------- payments (recorded by hand in v1.2)

export function canMovePaymentStatus(from: PaymentStatus, to: PaymentStatus): boolean {
  return PaymentStatusTransitions[from].includes(to)
}

export interface PaymentChangeInput {
  readonly orderStatus: OrderStatus
  // The method the order was sold with (Order.paymentMethod)
  readonly orderPaymentMethod: PaymentMethod
  readonly from: PaymentStatus
  readonly to: PaymentStatus
}

// A cancelled order takes no payment (a refund of one already paid is still recorded). On a CASH_ON_DELIVERY order the
// customer pays the carrier, who remits to the store (Step 4.13): by hand it is COMPLETED only once delivered, and
// that is not the same as a transfer, which the customer may make before. Staying in the same status is allowed (the
// agent adds the reference or the receipt to a payment that is still pending, or corrects it), under the same two
// guards. The recorded method (how the money came) never changes Order.paymentMethod (how the order was sold): the
// cash-on-delivery rule reads the second, so a payment recorded as cash does not lift it.
export function checkPaymentChange({
  orderStatus,
  orderPaymentMethod,
  from,
  to
}: PaymentChangeInput): Verdict {
  if (from !== to && !canMovePaymentStatus(from, to)) {
    return refuse(ErrorCodes.ORDER_PAYMENT_INVALID_STATUS_TRANSITION)
  }
  if (orderStatus === OrderStatus.CANCELLED && to !== PaymentStatus.REFUNDED) {
    return refuse(ErrorCodes.ORDER_PAYMENT_NOT_ALLOWED)
  }
  // Only the move into COMPLETED waits for the delivery: a reference added later to a paid order is always welcome
  if (
    from !== to &&
    orderPaymentMethod === PaymentMethod.CASH_ON_DELIVERY &&
    to === PaymentStatus.COMPLETED &&
    orderStatus !== OrderStatus.DELIVERED
  ) {
    return refuse(ErrorCodes.ORDER_PAYMENT_NOT_ALLOWED)
  }
  return OK
}
