import { ErrorCodes } from './errors/error-codes'
import { ORDER_MAX_AMOUNT_CENTS, OrderFreeShippingRules, OrderLimits } from './order-constants'
import {
  canCancelOrder,
  canMovePaymentStatus,
  canMovePriceApproval,
  canTransitionOrder,
  checkOrderConfirmation,
  checkOrderEdit,
  checkOrderTransition,
  checkPaymentChange,
  checkPriceDecision,
  computeOrderTotals,
  editableOrderFields,
  evaluatePriceControl,
  isDiscountWithinLimit,
  isFreeShippingOrder,
  isPriceApprovalBlocking,
  isShippingFeeWithinRange,
  lockedOrderFields,
  normalizeNote,
  ShippingFeeBoundKinds,
  shouldWarnWarehouseOfPackingNote,
  type PriceControlInput,
  type ShippingFeeBounds
} from './order-rules'
import { OrderStatus, PaymentMethod, PaymentStatus, PriceApprovalStatus } from './status-enums'

const NO_SHIPMENT = { hasActiveShipment: false }
const ALL_STATUSES = Object.values(OrderStatus)

describe('the order state machine', () => {
  it('allows exactly the transitions of the table and no other', () => {
    expect(canTransitionOrder(OrderStatus.PENDING_CONFIRMATION, OrderStatus.CONFIRMED)).toBe(true)
    expect(canTransitionOrder(OrderStatus.CONFIRMED, OrderStatus.SHIPPED)).toBe(true)
    expect(canTransitionOrder(OrderStatus.PENDING_CONFIRMATION, OrderStatus.SHIPPED)).toBe(false)
    expect(canTransitionOrder(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toBe(false)
  })

  it('refuses every move out of a terminal status and every move to the same status', () => {
    for (const to of ALL_STATUSES) {
      expect(canTransitionOrder(OrderStatus.CANCELLED, to)).toBe(false)
      expect(canTransitionOrder(OrderStatus.RETURNED, to)).toBe(false)
      expect(canTransitionOrder(to, to)).toBe(false)
    }
  })

  it('answers with the error code of an illegal transition', () => {
    expect(checkOrderTransition(OrderStatus.SHIPPED, OrderStatus.CONFIRMED)).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_INVALID_STATUS_TRANSITION
    })
    expect(checkOrderTransition(OrderStatus.CONFIRMED, OrderStatus.PREPARING)).toEqual({ ok: true })
  })

  it('cancels from the statuses before the order leaves, and from no other', () => {
    expect(ALL_STATUSES.filter(status => canCancelOrder(status)).sort()).toEqual(
      [OrderStatus.PENDING_CONFIRMATION, OrderStatus.CONFIRMED, OrderStatus.PREPARING].sort()
    )
  })
})

describe('editable fields', () => {
  it('locks the fields the status does not list', () => {
    expect(lockedOrderFields(OrderStatus.PREPARING, ['items', 'address'], NO_SHIPMENT)).toEqual([
      'items'
    ])
    expect(lockedOrderFields(OrderStatus.CANCELLED, ['customerNotes'], NO_SHIPMENT)).toEqual([
      'customerNotes'
    ])
  })

  it('takes the tracking number away while a shipment is active', () => {
    expect(editableOrderFields(OrderStatus.SHIPPED, NO_SHIPMENT)).toContain('trackingNumber')
    expect(editableOrderFields(OrderStatus.SHIPPED, { hasActiveShipment: true })).not.toContain(
      'trackingNumber'
    )
    // A status that never listed it is the same list with or without a shipment
    expect(editableOrderFields(OrderStatus.CONFIRMED, { hasActiveShipment: true })).toEqual(
      editableOrderFields(OrderStatus.CONFIRMED, NO_SHIPMENT)
    )
  })

  it('answers ORDER_FIELD_NOT_EDITABLE for a locked field and ok for an allowed one', () => {
    expect(checkOrderEdit(OrderStatus.DELIVERED, ['address'], NO_SHIPMENT)).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_FIELD_NOT_EDITABLE
    })
    expect(checkOrderEdit(OrderStatus.DELIVERED, ['customerNotes'], NO_SHIPMENT)).toEqual({
      ok: true
    })
    expect(checkOrderEdit(OrderStatus.CONFIRMED, [], NO_SHIPMENT)).toEqual({ ok: true })
  })

  it('lets the three notes, the phones and the scheduled day be edited while the order is not packed', () => {
    for (const field of [
      'customerNotes',
      'internalNotes',
      'packingNotes',
      'recipientPhones',
      'scheduledDeliveryDate'
    ] as const) {
      expect(editableOrderFields(OrderStatus.PENDING_CONFIRMATION, NO_SHIPMENT)).toContain(field)
      expect(editableOrderFields(OrderStatus.CONFIRMED, NO_SHIPMENT)).toContain(field)
      expect(editableOrderFields(OrderStatus.PREPARING, NO_SHIPMENT)).toContain(field)
    }
  })

  it('ends the packing note when the order leaves the warehouse', () => {
    for (const status of [
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.CANCELLED,
      OrderStatus.RETURNED
    ]) {
      expect(editableOrderFields(status, NO_SHIPMENT)).not.toContain('packingNotes')
    }
  })

  it('keeps the other two notes editable after the order is closed, except when cancelled', () => {
    for (const status of [OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.RETURNED]) {
      expect(editableOrderFields(status, NO_SHIPMENT)).toEqual(
        expect.arrayContaining(['customerNotes', 'internalNotes'])
      )
    }
    expect(editableOrderFields(OrderStatus.CANCELLED, NO_SHIPMENT)).toEqual([])
  })
})

describe('notes', () => {
  it('reads an empty or blank note as no note', () => {
    expect(normalizeNote(undefined)).toBeNull()
    expect(normalizeNote(null)).toBeNull()
    expect(normalizeNote('   ')).toBeNull()
    expect(normalizeNote('  box it twice ')).toBe('box it twice')
  })

  it('warns the warehouse only of a real change on an order waiting to be packed', () => {
    expect(shouldWarnWarehouseOfPackingNote(OrderStatus.CONFIRMED, null, 'gift wrap')).toBe(true)
    expect(shouldWarnWarehouseOfPackingNote(OrderStatus.PREPARING, 'a', 'b')).toBe(true)
    expect(shouldWarnWarehouseOfPackingNote(OrderStatus.CONFIRMED, 'gift wrap', null)).toBe(true)
  })

  it('does not warn when the note did not change, or the order is not waiting to be packed', () => {
    expect(shouldWarnWarehouseOfPackingNote(OrderStatus.CONFIRMED, 'a', ' a ')).toBe(false)
    expect(shouldWarnWarehouseOfPackingNote(OrderStatus.CONFIRMED, null, '  ')).toBe(false)
    expect(shouldWarnWarehouseOfPackingNote(OrderStatus.PENDING_CONFIRMATION, null, 'x')).toBe(
      false
    )
    expect(shouldWarnWarehouseOfPackingNote(OrderStatus.SHIPPED, null, 'x')).toBe(false)
  })
})

describe('computeOrderTotals', () => {
  const line = (unitPriceCents: number, quantity: number, freeShipping = false) => ({
    unitPriceCents,
    quantity,
    freeShipping
  })

  it('adds the lines, the shipping and takes the discount, to the cent', () => {
    expect(
      computeOrderTotals({
        lines: [line(4500, 1), line(333, 3)],
        shippingCents: 300,
        discountCents: 99
      })
    ).toEqual({
      ok: true,
      subtotalCents: 5499,
      shippingCents: 300,
      discountCents: 99,
      totalCents: 5700
    })
  })

  it('does not round: three lines of 0.10 add to 0.30 exactly', () => {
    const result = computeOrderTotals({
      lines: [line(10, 1), line(10, 1), line(10, 1)],
      shippingCents: 0,
      discountCents: 0
    })
    expect(result).toMatchObject({ ok: true, subtotalCents: 30, totalCents: 30 })
  })

  it('accepts a free line and a discount equal to the subtotal', () => {
    expect(
      computeOrderTotals({ lines: [line(0, 2)], shippingCents: 0, discountCents: 0 })
    ).toMatchObject({ ok: true, totalCents: 0 })
    expect(
      computeOrderTotals({ lines: [line(500, 1)], shippingCents: 100, discountCents: 500 })
    ).toMatchObject({ ok: true, totalCents: 100 })
  })

  it('refuses a discount larger than the subtotal', () => {
    expect(
      computeOrderTotals({ lines: [line(500, 1)], shippingCents: 0, discountCents: 501 })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_DISCOUNT_EXCEEDS_SUBTOTAL })
  })

  it('accepts the largest total the column holds and refuses one cent more', () => {
    expect(
      computeOrderTotals({
        lines: [line(ORDER_MAX_AMOUNT_CENTS - 1, 1)],
        shippingCents: 1,
        discountCents: 0
      })
    ).toMatchObject({ ok: true, totalCents: ORDER_MAX_AMOUNT_CENTS })
    expect(
      computeOrderTotals({
        lines: [line(ORDER_MAX_AMOUNT_CENTS - 1, 1)],
        shippingCents: 2,
        discountCents: 0
      })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE })
  })

  it('refuses a subtotal beyond the column even when the discount would bring the total back', () => {
    expect(
      computeOrderTotals({
        lines: [line(ORDER_MAX_AMOUNT_CENTS, 1), line(10, 1)],
        shippingCents: 0,
        discountCents: 10
      })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE })
    // 100,000,000 cents (the ceiling of a price) times 10,000 units overflows at once
    expect(
      computeOrderTotals({ lines: [line(100_000_000, 10_000)], shippingCents: 0, discountCents: 0 })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE })
  })

  it('refuses what is not whole cents, negative, or an order with no lines', () => {
    const refused = { ok: false, code: ErrorCodes.ORDER_TOTAL_OUT_OF_RANGE }
    expect(computeOrderTotals({ lines: [], shippingCents: 0, discountCents: 0 })).toEqual({
      ok: false,
      code: ErrorCodes.VALIDATION_FAILED
    })
    expect(
      computeOrderTotals({
        lines: [line(1, OrderLimits.MAX_QUANTITY_PER_LINE + 1)],
        shippingCents: 0,
        discountCents: 0
      })
    ).toEqual(refused)
    // Each part alone must fit its 32-bit column, whatever the others do
    const big = ORDER_MAX_AMOUNT_CENTS + 1
    expect(
      computeOrderTotals({ lines: [line(100, 1)], shippingCents: big, discountCents: 0 })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(100, 1)], shippingCents: 0, discountCents: big })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(100, 1)], shippingCents: 0.5, discountCents: 0 })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(100, 1)], shippingCents: -1, discountCents: 0 })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(100, 1)], shippingCents: 0, discountCents: Number.NaN })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(1.5, 1)], shippingCents: 0, discountCents: 0 })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(-1, 1)], shippingCents: 0, discountCents: 0 })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(100, 0)], shippingCents: 0, discountCents: 0 })
    ).toEqual(refused)
    expect(
      computeOrderTotals({ lines: [line(100, 1.5)], shippingCents: 0, discountCents: 0 })
    ).toEqual(refused)
  })
})

describe('isDiscountWithinLimit', () => {
  it('allows nothing while the limit is 0, and the zero discount always', () => {
    expect(isDiscountWithinLimit(0, 5000, 0)).toBe(true)
    expect(isDiscountWithinLimit(1, 5000, 0)).toBe(false)
    expect(isDiscountWithinLimit(0, 0, 0)).toBe(true)
    expect(isDiscountWithinLimit(1, 0, 100)).toBe(false)
  })

  it('compares in whole numbers: 10% of 333 cents is 33, not 34', () => {
    expect(isDiscountWithinLimit(33, 333, 10)).toBe(true)
    expect(isDiscountWithinLimit(34, 333, 10)).toBe(false)
  })

  it('reads a limit that is not a number from 0 to 100 as the strictest one', () => {
    expect(isDiscountWithinLimit(1, 5000, Number.NaN)).toBe(false)
    expect(isDiscountWithinLimit(1, 5000, -5)).toBe(false)
    expect(isDiscountWithinLimit(0, 5000, Number.NaN)).toBe(true)
    // Above 100 is 100: a discount larger than the subtotal is never "within the limit"
    expect(isDiscountWithinLimit(5001, 5000, 500)).toBe(false)
    expect(isDiscountWithinLimit(5000, 5000, 500)).toBe(true)
  })

  it('allows the whole subtotal at 100%', () => {
    expect(isDiscountWithinLimit(5000, 5000, 100)).toBe(true)
  })
})

describe('free shipping', () => {
  const flagged = { freeShipping: true }
  const plain = { freeShipping: false }

  it('needs every line flagged under all_items, and an empty cart is not free', () => {
    expect(isFreeShippingOrder([flagged, flagged], OrderFreeShippingRules.ALL_ITEMS)).toBe(true)
    expect(isFreeShippingOrder([flagged, plain], OrderFreeShippingRules.ALL_ITEMS)).toBe(false)
    expect(isFreeShippingOrder([], OrderFreeShippingRules.ALL_ITEMS)).toBe(false)
  })

  it('needs one line flagged under any_item', () => {
    expect(isFreeShippingOrder([plain, flagged], OrderFreeShippingRules.ANY_ITEM)).toBe(true)
    expect(isFreeShippingOrder([plain, plain], OrderFreeShippingRules.ANY_ITEM)).toBe(false)
    expect(isFreeShippingOrder([], OrderFreeShippingRules.ANY_ITEM)).toBe(false)
  })
})

describe('isShippingFeeWithinRange', () => {
  const carrier = (minCents: number | null, maxCents: number | null): ShippingFeeBounds => ({
    kind: ShippingFeeBoundKinds.CARRIER,
    minCents,
    maxCents
  })
  const unmanaged: ShippingFeeBounds = { kind: ShippingFeeBoundKinds.UNMANAGED }
  const noCarrier: ShippingFeeBounds = { kind: ShippingFeeBoundKinds.NO_CARRIER }

  it('accepts 0 on a free-shipping order whatever the carrier minimum, and nothing else', () => {
    expect(isShippingFeeWithinRange(0, true, carrier(300, 500))).toBe(true)
    expect(isShippingFeeWithinRange(300, true, carrier(300, 500))).toBe(false)
    expect(isShippingFeeWithinRange(1, true, unmanaged)).toBe(false)
  })

  it('has no limit before the carrier connections exist, apart from free shipping', () => {
    expect(isShippingFeeWithinRange(0, false, unmanaged)).toBe(true)
    expect(isShippingFeeWithinRange(99_999, false, unmanaged)).toBe(true)
  })

  it('accepts only 0 when the order names no carrier', () => {
    expect(isShippingFeeWithinRange(0, false, noCarrier)).toBe(true)
    expect(isShippingFeeWithinRange(1, false, noCarrier)).toBe(false)
  })

  it('holds the fee to the range of the carrier, the ends included', () => {
    expect(isShippingFeeWithinRange(300, false, carrier(300, 500))).toBe(true)
    expect(isShippingFeeWithinRange(500, false, carrier(300, 500))).toBe(true)
    expect(isShippingFeeWithinRange(299, false, carrier(300, 500))).toBe(false)
    expect(isShippingFeeWithinRange(501, false, carrier(300, 500))).toBe(false)
  })

  it('treats an empty side as no bound on that side', () => {
    expect(isShippingFeeWithinRange(0, false, carrier(null, 500))).toBe(true)
    expect(isShippingFeeWithinRange(501, false, carrier(null, 500))).toBe(false)
    expect(isShippingFeeWithinRange(99_999, false, carrier(300, null))).toBe(true)
    expect(isShippingFeeWithinRange(299, false, carrier(300, null))).toBe(false)
    expect(isShippingFeeWithinRange(5, false, carrier(null, null))).toBe(true)
  })
})

describe('evaluatePriceControl', () => {
  const base: PriceControlInput = {
    canOverridePrice: false,
    linePriceChanged: false,
    discountCents: 0,
    shippingCents: 300,
    subtotalCents: 5000,
    discountLimitPercent: 0,
    feeWithinRange: true,
    approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
    reason: null,
    approved: null
  }
  // An order that holds approved values is APPROVED unless the test says otherwise
  const run = (change: Partial<PriceControlInput>) =>
    evaluatePriceControl({
      ...base,
      approvalStatus: change.approved ? PriceApprovalStatus.APPROVED : base.approvalStatus,
      ...change
    })

  it('does not put a discount the order already had to a new test when something else is edited', () => {
    const held = { discountCents: 2000, reason: 'vip', discountUnchanged: true }
    // Sanctioned before (an override set it): changing only the fee leaves the order as it was
    expect(run(held)).toMatchObject({
      ok: true,
      approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
      needsApproval: false
    })
    // The same discount, not known to be unchanged, is over the limit of 0
    expect(run({ ...held, discountUnchanged: false })).toMatchObject({ needsApproval: true })
    expect(run({ ...held, discountUnchanged: undefined })).toMatchObject({ needsApproval: true })
    // A request that is open sanctions nothing: the discount is still over the limit
    expect(run({ ...held, approvalStatus: PriceApprovalStatus.PENDING })).toMatchObject({
      needsApproval: true,
      approvalStatus: PriceApprovalStatus.PENDING
    })
  })

  it('does not put a fee the order already had to a new test either, and still asks the reason of a discount', () => {
    expect(run({ feeWithinRange: false, feeUnchanged: true, reason: 'courier' })).toMatchObject({
      needsApproval: false,
      approvalStatus: PriceApprovalStatus.NOT_REQUIRED
    })
    expect(run({ feeWithinRange: false, feeUnchanged: false, reason: 'courier' })).toMatchObject({
      needsApproval: true
    })
    expect(
      run({
        feeWithinRange: false,
        feeUnchanged: true,
        reason: 'courier',
        approvalStatus: PriceApprovalStatus.REJECTED
      })
    ).toMatchObject({
      needsApproval: true
    })
    expect(run({ discountCents: 100, reason: null, discountUnchanged: true })).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_PRICE_REASON_REQUIRED
    })
  })

  it('needs nothing for an order at catalog prices with no discount', () => {
    expect(run({})).toEqual({
      ok: true,
      approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
      needsApproval: false,
      overridden: false,
      withdrawsRequest: false
    })
  })

  it('locks the line prices without the override permission', () => {
    expect(run({ linePriceChanged: true, reason: 'because' })).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_PRICE_OVERRIDE_FORBIDDEN
    })
  })

  it('lets a member with the override permission change a price, with a reason, and never asks for approval', () => {
    expect(
      run({ canOverridePrice: true, linePriceChanged: true, reason: 'loyal customer' })
    ).toEqual({
      ok: true,
      approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
      needsApproval: false,
      overridden: true,
      withdrawsRequest: false
    })
    // Over the limit and out of range: still no approval at level 1
    expect(
      run({
        canOverridePrice: true,
        discountCents: 4000,
        feeWithinRange: false,
        reason: 'owner decision'
      })
    ).toMatchObject({ approvalStatus: PriceApprovalStatus.NOT_REQUIRED, needsApproval: false })
  })

  it('tells the service that a change withdraws the request the order held', () => {
    const lowered = { discountCents: 100, discountLimitPercent: 10, reason: 'promo' }
    for (const approvalStatus of [
      PriceApprovalStatus.PENDING,
      PriceApprovalStatus.REJECTED,
      PriceApprovalStatus.APPROVED
    ]) {
      expect(run({ ...lowered, approvalStatus })).toMatchObject({
        approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
        withdrawsRequest: true
      })
    }
    expect(run({ ...lowered })).toMatchObject({ withdrawsRequest: false })
    // A request that is still needed is not withdrawn
    expect(
      run({
        discountCents: 900,
        discountLimitPercent: 10,
        reason: 'x',
        approvalStatus: PriceApprovalStatus.PENDING
      })
    ).toMatchObject({ approvalStatus: PriceApprovalStatus.PENDING, withdrawsRequest: false })
  })

  it('requires a reason for a price change, any discount and a fee out of range, and a blank one is none', () => {
    const required = { ok: false, code: ErrorCodes.ORDER_PRICE_REASON_REQUIRED }
    expect(run({ canOverridePrice: true, linePriceChanged: true })).toEqual(required)
    expect(run({ discountCents: 100, discountLimitPercent: 10, reason: '   ' })).toEqual(required)
    expect(run({ feeWithinRange: false, reason: '' })).toEqual(required)
    expect(run({ discountCents: 100, discountLimitPercent: 10, reason: 'promo' })).toMatchObject({
      ok: true
    })
  })

  it('accepts a discount inside the limit without approval, and the same discount over it asks for one', () => {
    expect(run({ discountCents: 500, discountLimitPercent: 10, reason: 'promo' })).toMatchObject({
      approvalStatus: PriceApprovalStatus.NOT_REQUIRED,
      needsApproval: false,
      overridden: false
    })
    expect(run({ discountCents: 501, discountLimitPercent: 10, reason: 'promo' })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING,
      needsApproval: true
    })
  })

  it('allows no discount at all while the limit is 0, so the first one asks for approval', () => {
    expect(run({ discountCents: 1, reason: 'promo' })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
  })

  it('asks for approval for a fee out of range, with a reason', () => {
    expect(run({ feeWithinRange: false, reason: 'special route' })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING,
      needsApproval: true
    })
  })

  it('keeps an approval that covers the discount and the fee, and asks again when they move past it', () => {
    const approved = { discountCents: 800, shippingCents: 100 }
    const over = { discountCents: 700, discountLimitPercent: 10, reason: 'promo', approved }
    expect(run(over)).toMatchObject({ approvalStatus: PriceApprovalStatus.APPROVED })
    expect(run({ ...over, discountCents: 800 })).toMatchObject({
      approvalStatus: PriceApprovalStatus.APPROVED
    })
    expect(run({ ...over, discountCents: 801 })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
    // The same discount with no approval behind it
    expect(run({ ...over, approved: null })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
    // An approval that named no discount covers none
    expect(run({ ...over, approved: { discountCents: null, shippingCents: null } })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
  })

  it('ignores the numbers an earlier request left when its approval is not the current one', () => {
    const left = {
      discountCents: 400,
      discountLimitPercent: 10,
      subtotalCents: 1000,
      reason: 'promo',
      approved: { discountCents: 500, shippingCents: null }
    }
    expect(run(left)).toMatchObject({ approvalStatus: PriceApprovalStatus.APPROVED })
    for (const approvalStatus of [
      PriceApprovalStatus.REJECTED,
      PriceApprovalStatus.PENDING,
      PriceApprovalStatus.NOT_REQUIRED
    ]) {
      expect(run({ ...left, approvalStatus })).toMatchObject({
        approvalStatus: PriceApprovalStatus.PENDING
      })
    }
  })

  it('keeps an approved fee only for exactly that fee', () => {
    const out = {
      feeWithinRange: false,
      reason: 'special route',
      shippingCents: 100,
      approved: { discountCents: null, shippingCents: 100 }
    }
    expect(run(out)).toMatchObject({ approvalStatus: PriceApprovalStatus.APPROVED })
    expect(run({ ...out, shippingCents: 101 })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
    expect(run({ ...out, approved: null })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
  })

  it('needs both the discount and the fee covered when both are outside', () => {
    const both = {
      discountCents: 700,
      discountLimitPercent: 10,
      feeWithinRange: false,
      shippingCents: 100,
      reason: 'x'
    }
    expect(run({ ...both, approved: { discountCents: 800, shippingCents: 100 } })).toMatchObject({
      approvalStatus: PriceApprovalStatus.APPROVED
    })
    expect(run({ ...both, approved: { discountCents: 800, shippingCents: 99 } })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
    expect(run({ ...both, approved: { discountCents: 600, shippingCents: 100 } })).toMatchObject({
      approvalStatus: PriceApprovalStatus.PENDING
    })
  })

  it('does not let an old approval cover a discount that is now inside the limit but a fee that is not', () => {
    expect(
      run({
        discountCents: 100,
        discountLimitPercent: 10,
        feeWithinRange: false,
        shippingCents: 500,
        reason: 'x',
        approved: { discountCents: 900, shippingCents: 100 }
      })
    ).toMatchObject({ approvalStatus: PriceApprovalStatus.PENDING })
  })
})

describe('price decisions', () => {
  const pending = {
    status: PriceApprovalStatus.PENDING,
    requestedBy: 'u1',
    approverId: 'u2'
  } as const

  it('lets another member approve or reject a pending request', () => {
    expect(checkPriceDecision({ ...pending, decision: PriceApprovalStatus.APPROVED })).toEqual({
      ok: true
    })
    expect(checkPriceDecision({ ...pending, decision: PriceApprovalStatus.REJECTED })).toEqual({
      ok: true
    })
  })

  it('refuses the approval of your own request, and lets you withdraw it', () => {
    expect(
      checkPriceDecision({ ...pending, approverId: 'u1', decision: PriceApprovalStatus.APPROVED })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_PRICE_SELF_APPROVAL })
    expect(
      checkPriceDecision({ ...pending, approverId: 'u1', decision: PriceApprovalStatus.REJECTED })
    ).toEqual({ ok: true })
  })

  it('lets a rejected request be approved later, by someone else, and not rejected twice', () => {
    const rejected = { ...pending, status: PriceApprovalStatus.REJECTED }
    expect(checkPriceDecision({ ...rejected, decision: PriceApprovalStatus.APPROVED })).toEqual({
      ok: true
    })
    expect(
      checkPriceDecision({ ...rejected, approverId: 'u1', decision: PriceApprovalStatus.APPROVED })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_PRICE_SELF_APPROVAL })
    expect(checkPriceDecision({ ...rejected, decision: PriceApprovalStatus.REJECTED })).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_PRICE_APPROVAL_NOT_PENDING
    })
  })

  it('refuses a decision on a request that is not waiting', () => {
    for (const status of [PriceApprovalStatus.NOT_REQUIRED, PriceApprovalStatus.APPROVED]) {
      expect(
        checkPriceDecision({ ...pending, status, decision: PriceApprovalStatus.APPROVED })
      ).toEqual({ ok: false, code: ErrorCodes.ORDER_PRICE_APPROVAL_NOT_PENDING })
    }
  })

  it('does not call a request with no author a self-approval', () => {
    expect(
      checkPriceDecision({ ...pending, requestedBy: null, decision: PriceApprovalStatus.APPROVED })
    ).toEqual({ ok: true })
  })

  it('follows the transition table of the approval', () => {
    expect(canMovePriceApproval(PriceApprovalStatus.REJECTED, PriceApprovalStatus.APPROVED)).toBe(
      true
    )
    expect(
      canMovePriceApproval(PriceApprovalStatus.NOT_REQUIRED, PriceApprovalStatus.APPROVED)
    ).toBe(false)
    expect(canMovePriceApproval(PriceApprovalStatus.APPROVED, PriceApprovalStatus.REJECTED)).toBe(
      false
    )
  })

  it('blocks an order whose approval waits or was rejected', () => {
    expect(isPriceApprovalBlocking(PriceApprovalStatus.PENDING)).toBe(true)
    expect(isPriceApprovalBlocking(PriceApprovalStatus.REJECTED)).toBe(true)
    expect(isPriceApprovalBlocking(PriceApprovalStatus.APPROVED)).toBe(false)
    expect(isPriceApprovalBlocking(PriceApprovalStatus.NOT_REQUIRED)).toBe(false)
  })
})

describe('checkOrderConfirmation', () => {
  it('confirms a pending order with no approval open', () => {
    expect(
      checkOrderConfirmation(OrderStatus.PENDING_CONFIRMATION, PriceApprovalStatus.NOT_REQUIRED)
    ).toEqual({ ok: true })
    expect(
      checkOrderConfirmation(OrderStatus.PENDING_CONFIRMATION, PriceApprovalStatus.APPROVED)
    ).toEqual({ ok: true })
  })

  it('refuses an order that waits for a price approval, or whose request was rejected', () => {
    for (const approval of [PriceApprovalStatus.PENDING, PriceApprovalStatus.REJECTED]) {
      expect(checkOrderConfirmation(OrderStatus.PENDING_CONFIRMATION, approval)).toEqual({
        ok: false,
        code: ErrorCodes.ORDER_PRICE_APPROVAL_PENDING
      })
    }
  })

  it('tells an order that is already confirmed, and one that cannot be', () => {
    expect(checkOrderConfirmation(OrderStatus.CONFIRMED, PriceApprovalStatus.NOT_REQUIRED)).toEqual(
      {
        ok: false,
        code: ErrorCodes.ORDER_ALREADY_CONFIRMED
      }
    )
    expect(checkOrderConfirmation(OrderStatus.CANCELLED, PriceApprovalStatus.NOT_REQUIRED)).toEqual(
      {
        ok: false,
        code: ErrorCodes.ORDER_INVALID_STATUS_TRANSITION
      }
    )
  })
})

describe('payments recorded by hand', () => {
  const change = (
    overrides: Partial<Parameters<typeof checkPaymentChange>[0]>
  ): ReturnType<typeof checkPaymentChange> =>
    checkPaymentChange({
      orderStatus: OrderStatus.CONFIRMED,
      orderPaymentMethod: PaymentMethod.TRANSFER,
      from: PaymentStatus.PENDING,
      to: PaymentStatus.COMPLETED,
      ...overrides
    })

  it('follows the table: pending to paid or failed, failed to retry or paid, paid to refunded', () => {
    expect(canMovePaymentStatus(PaymentStatus.PENDING, PaymentStatus.COMPLETED)).toBe(true)
    expect(canMovePaymentStatus(PaymentStatus.PENDING, PaymentStatus.FAILED)).toBe(true)
    expect(canMovePaymentStatus(PaymentStatus.FAILED, PaymentStatus.PENDING)).toBe(true)
    expect(canMovePaymentStatus(PaymentStatus.FAILED, PaymentStatus.COMPLETED)).toBe(true)
    expect(canMovePaymentStatus(PaymentStatus.COMPLETED, PaymentStatus.REFUNDED)).toBe(true)
    expect(canMovePaymentStatus(PaymentStatus.PENDING, PaymentStatus.REFUNDED)).toBe(false)
    expect(canMovePaymentStatus(PaymentStatus.REFUNDED, PaymentStatus.COMPLETED)).toBe(false)
    expect(canMovePaymentStatus(PaymentStatus.COMPLETED, PaymentStatus.COMPLETED)).toBe(false)
  })

  it('accepts a transfer, cash or card payment on an order being prepared', () => {
    for (const orderPaymentMethod of [
      PaymentMethod.TRANSFER,
      PaymentMethod.CASH,
      PaymentMethod.CARD
    ]) {
      expect(change({ orderPaymentMethod })).toEqual({ ok: true })
    }
    expect(change({ orderStatus: OrderStatus.PENDING_CONFIRMATION })).toEqual({ ok: true })
  })

  it('lets a payment stay in its status, to add the reference or the receipt, under the same guards', () => {
    expect(change({ from: PaymentStatus.PENDING, to: PaymentStatus.PENDING })).toEqual({ ok: true })
    expect(change({ from: PaymentStatus.COMPLETED, to: PaymentStatus.COMPLETED })).toEqual({
      ok: true
    })
    expect(
      change({
        orderStatus: OrderStatus.CANCELLED,
        from: PaymentStatus.PENDING,
        to: PaymentStatus.PENDING
      })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_PAYMENT_NOT_ALLOWED })
    expect(
      change({
        orderPaymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        orderStatus: OrderStatus.SHIPPED,
        from: PaymentStatus.PENDING,
        to: PaymentStatus.COMPLETED
      })
    ).toEqual({ ok: false, code: ErrorCodes.ORDER_PAYMENT_NOT_ALLOWED })
  })

  it('refuses a move the table does not have', () => {
    expect(change({ from: PaymentStatus.REFUNDED })).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_PAYMENT_INVALID_STATUS_TRANSITION
    })
  })

  it('takes no payment on a cancelled order, but records the refund of one that was paid', () => {
    expect(change({ orderStatus: OrderStatus.CANCELLED })).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_PAYMENT_NOT_ALLOWED
    })
    expect(
      change({
        orderStatus: OrderStatus.CANCELLED,
        from: PaymentStatus.COMPLETED,
        to: PaymentStatus.REFUNDED
      })
    ).toEqual({ ok: true })
  })

  it('completes a cash-on-delivery payment only once the order is delivered', () => {
    const cod = { orderPaymentMethod: PaymentMethod.CASH_ON_DELIVERY }
    expect(change({ ...cod, orderStatus: OrderStatus.SHIPPED })).toEqual({
      ok: false,
      code: ErrorCodes.ORDER_PAYMENT_NOT_ALLOWED
    })
    expect(change({ ...cod, orderStatus: OrderStatus.DELIVERED })).toEqual({ ok: true })
    // A paid COD order that was returned still takes a reference or a receipt on its paid payment
    expect(
      change({
        ...cod,
        orderStatus: OrderStatus.RETURNED,
        from: PaymentStatus.COMPLETED,
        to: PaymentStatus.COMPLETED
      })
    ).toEqual({ ok: true })
    // A failed attempt is recorded whenever it happens, and the same order paid by transfer needs no delivery
    expect(change({ ...cod, orderStatus: OrderStatus.SHIPPED, to: PaymentStatus.FAILED })).toEqual({
      ok: true
    })
    expect(change({ orderStatus: OrderStatus.CONFIRMED })).toEqual({ ok: true })
  })
})
