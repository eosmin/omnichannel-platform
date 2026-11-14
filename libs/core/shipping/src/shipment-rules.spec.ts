import {
  CarrierCapability,
  OrderStatus,
  PriceApprovalStatus,
  ShipmentLimits,
  ShipmentStatus,
  ShipmentStatusTransitions,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import { CarrierCredentialsUnreadableError } from './carrier-context'
import {
  CarrierCallOutcomes,
  classifyCarrierError,
  clampCarrierMessage,
  codAmountFor,
  creationCapabilityOf,
  failureReasonOf,
  isFeeAcceptedForGuide,
  isShipmentTransitionAllowed,
  isUsableGuideNumber,
  mayRetryCreate,
  mayRetryVoid,
  nextPickupDate,
  orderBlockOf,
  rateServiceOf,
  wallClockOf
} from './shipment-rules'

describe('the state machine of a shipment', () => {
  it('allows exactly the table of transitions and nothing backwards', () => {
    for (const from of Object.values(ShipmentStatus)) {
      for (const to of Object.values(ShipmentStatus)) {
        expect(isShipmentTransitionAllowed(from, to)).toBe(
          ShipmentStatusTransitions[from].includes(to)
        )
      }
    }
    expect(isShipmentTransitionAllowed(ShipmentStatus.DELIVERED, ShipmentStatus.PICKED_UP)).toBe(
      false
    )
    expect(isShipmentTransitionAllowed(ShipmentStatus.FAILED, ShipmentStatus.LABEL_CREATED)).toBe(
      false
    )
    // A repeated failed attempt is the one status that goes to itself
    expect(
      isShipmentTransitionAllowed(ShipmentStatus.FAILED_ATTEMPT, ShipmentStatus.FAILED_ATTEMPT)
    ).toBe(true)
    expect(isShipmentTransitionAllowed(ShipmentStatus.PICKED_UP, ShipmentStatus.PICKED_UP)).toBe(
      false
    )
  })
})

describe('what an order needs to get a guide', () => {
  const ready = {
    status: OrderStatus.CONFIRMED,
    priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED,
    shippingAddress: { line1: 'x' },
    recipientPhones: ['71234567']
  }

  it('accepts a confirmed or a preparing order with an address and a phone', () => {
    expect(orderBlockOf(ready)).toBeNull()
    expect(orderBlockOf({ ...ready, status: OrderStatus.PREPARING })).toBeNull()
  })

  it.each([
    [{ status: OrderStatus.PENDING_CONFIRMATION }, ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED],
    [{ status: OrderStatus.SHIPPED }, ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED],
    [{ status: OrderStatus.CANCELLED }, ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED],
    [{ priceApprovalStatus: PriceApprovalStatus.PENDING }, ErrorCodes.ORDER_PRICE_APPROVAL_PENDING],
    [
      { priceApprovalStatus: PriceApprovalStatus.REJECTED },
      ErrorCodes.ORDER_PRICE_APPROVAL_PENDING
    ],
    [{ shippingAddress: null }, ErrorCodes.SHIPPING_ADDRESS_MISSING],
    [{ recipientPhones: [] }, ErrorCodes.SHIPPING_RECIPIENT_PHONE_MISSING]
  ])('refuses %j with %s', (over, code) => {
    expect(orderBlockOf({ ...ready, ...over })).toBe(code)
  })

  it('accepts an approved price', () => {
    expect(orderBlockOf({ ...ready, priceApprovalStatus: PriceApprovalStatus.APPROVED })).toBeNull()
  })
})

describe('the capability each creation mode needs', () => {
  it('maps a mode to its capability', () => {
    expect(creationCapabilityOf('standalone')).toBe(CarrierCapability.CREATE_SHIPMENT)
    expect(creationCapabilityOf('pickup_bound')).toBe(CarrierCapability.PICKUP_BOUND_GUIDES)
    expect(creationCapabilityOf('internal')).toBe(CarrierCapability.INTERNAL_GUIDE)
  })
})

describe('the fee at guide time', () => {
  const base = {
    feeCents: 800,
    freeShipping: false,
    withinRange: false,
    approvedShippingCents: null,
    approvalStatus: PriceApprovalStatus.NOT_REQUIRED as string,
    canOverridePrice: false
  }

  it('accepts a fee in range, and refuses one out of it', () => {
    expect(isFeeAcceptedForGuide({ ...base, withinRange: true })).toBe(true)
    expect(isFeeAcceptedForGuide(base)).toBe(false)
  })

  it('lets whoever may override prices through', () => {
    expect(isFeeAcceptedForGuide({ ...base, canOverridePrice: true })).toBe(true)
  })

  it('accepts the fee an approver accepted, and only while the approval stands', () => {
    const approved = {
      ...base,
      approvedShippingCents: 800,
      approvalStatus: PriceApprovalStatus.APPROVED
    }
    expect(isFeeAcceptedForGuide(approved)).toBe(true)
    expect(isFeeAcceptedForGuide({ ...approved, feeCents: 900 })).toBe(false)
    expect(
      isFeeAcceptedForGuide({ ...approved, approvalStatus: PriceApprovalStatus.REJECTED })
    ).toBe(false)
    expect(isFeeAcceptedForGuide({ ...approved, approvedShippingCents: null })).toBe(false)
  })
})

describe('the amount a guide collects (TDD_17 §4.4)', () => {
  const order = {
    totalCents: 10_000,
    subtotalCents: 9_000,
    discountCents: 1_000,
    shippingCents: 2_000,
    collectsOnDelivery: true
  }
  const one = [{ warehouseId: 'a', linesCents: 9_000 }]
  const two = [
    { warehouseId: 'a', linesCents: 6_000 },
    { warehouseId: 'b', linesCents: 3_000 }
  ]

  it('collects nothing for a prepaid order', () => {
    expect(
      codAmountFor({
        order: { ...order, collectsOnDelivery: false },
        origins: one,
        originWarehouseId: 'a',
        others: []
      })
    ).toBeNull()
  })

  it('collects the whole total from a single origin', () => {
    expect(codAmountFor({ order, origins: one, originWarehouseId: 'a', others: [] })).toBe(10_000)
  })

  it('splits the total between origins so that the guides add up to it exactly', () => {
    const first = codAmountFor({ order, origins: two, originWarehouseId: 'a', others: [] })
    // 6000 of the lines, less a share of the discount (1000 * 6000 / 9000 = 666), plus the whole fee on the first guide
    expect(first).toBe(6_000 - 666 + 2_000)
    const last = codAmountFor({
      order,
      origins: two,
      originWarehouseId: 'b',
      others: [{ originWarehouseId: 'a', codAmountCents: first }]
    })
    expect((first ?? 0) + (last ?? 0)).toBe(order.totalCents)
  })

  it('gives a guide made again the share the others leave', () => {
    const again = codAmountFor({
      order,
      origins: two,
      originWarehouseId: 'a',
      others: [{ originWarehouseId: 'b', codAmountCents: 2_334 }]
    })
    expect(again).toBe(10_000 - 2_334)
  })

  it('never goes below zero', () => {
    expect(
      codAmountFor({
        order,
        origins: two,
        originWarehouseId: 'b',
        others: [{ originWarehouseId: 'a', codAmountCents: 99_999 }]
      })
    ).toBe(0)
  })

  it('asks the whole total when the origin is not one of the order', () => {
    expect(codAmountFor({ order, origins: two, originWarehouseId: 'z', others: [] })).toBe(10_000)
  })

  it('collects only what the guides of other origins leave when the order has one origin now', () => {
    expect(
      codAmountFor({
        order,
        origins: one,
        originWarehouseId: 'b',
        others: [{ originWarehouseId: 'a', codAmountCents: 10_000 }]
      })
    ).toBe(0)
    expect(
      codAmountFor({
        order,
        origins: one,
        originWarehouseId: 'a',
        others: [{ originWarehouseId: 'z', codAmountCents: 4_000 }]
      })
    ).toBe(6_000)
  })

  it('does not divide by a subtotal of zero', () => {
    expect(
      codAmountFor({
        order: { ...order, subtotalCents: 0, discountCents: 0 },
        origins: two,
        originWarehouseId: 'a',
        others: []
      })
    ).toBe(6_000 + 2_000)
  })
})

describe('what a carrier answered', () => {
  it('knows a refusal, a credentials problem and an unreadable credential', () => {
    expect(classifyCarrierError(new CarrierRejectedError('no'))).toBe(CarrierCallOutcomes.REJECTED)
    expect(classifyCarrierError(new CarrierAuthError('no'))).toBe(CarrierCallOutcomes.AUTH)
    expect(classifyCarrierError(new CarrierCredentialsUnreadableError())).toBe(
      CarrierCallOutcomes.UNREADABLE
    )
  })

  it('counts anything else as an unknown outcome: a guide may exist', () => {
    expect(classifyCarrierError(new CarrierUnavailableError('timeout'))).toBe(
      CarrierCallOutcomes.UNKNOWN
    )
    expect(classifyCarrierError(new TypeError('a bug of the plugin'))).toBe(
      CarrierCallOutcomes.UNKNOWN
    )
    expect(classifyCarrierError('a string')).toBe(CarrierCallOutcomes.UNKNOWN)
  })

  it('asks again only an unavailable carrier that promised an idempotent create', () => {
    expect(mayRetryCreate(new CarrierUnavailableError('x'), true)).toBe(true)
    expect(mayRetryCreate(new CarrierUnavailableError('x'), false)).toBe(false)
    expect(mayRetryCreate(new CarrierRejectedError('x'), true)).toBe(false)
    expect(mayRetryCreate(new TypeError('x'), true)).toBe(false)
  })

  it('asks a void again when the carrier did not answer, never when it said no (the key of a void is the same each time)', () => {
    expect(mayRetryVoid(new CarrierUnavailableError('timeout'))).toBe(true)
    expect(mayRetryVoid(new TypeError('a bug of the plugin'))).toBe(true)
    expect(mayRetryVoid(new CarrierRejectedError('the guide was used'))).toBe(false)
    expect(mayRetryVoid(new CarrierAuthError('bad credentials'))).toBe(false)
    expect(mayRetryVoid(new CarrierCredentialsUnreadableError())).toBe(false)
  })

  it('names the reason of a failure that the platform decided', () => {
    expect(failureReasonOf(CarrierCallOutcomes.AUTH)).toBe('auth')
    expect(failureReasonOf(CarrierCallOutcomes.UNREADABLE)).toBe('credentials_unreadable')
    expect(failureReasonOf(CarrierCallOutcomes.UNKNOWN)).toBe('unknown_outcome')
  })

  it('keeps one bounded line of what a carrier said', () => {
    expect(clampCarrierMessage('  bad\n\taddress\u0000 here  ')).toBe('bad address here')
    expect(clampCarrierMessage('x'.repeat(1_000))).toHaveLength(
      ShipmentLimits.LAST_ERROR_MAX_LENGTH
    )
    expect(clampCarrierMessage('\u0007\u001b')).toBe('')
  })

  it('takes as a guide a plain line of a sane length only', () => {
    expect(isUsableGuideNumber('FAKE-000001')).toBe(true)
    expect(isUsableGuideNumber('')).toBe(false)
    expect(isUsableGuideNumber(' padded')).toBe(false)
    expect(isUsableGuideNumber('two\nlines')).toBe(false)
    expect(isUsableGuideNumber('x'.repeat(ShipmentLimits.GUIDE_NUMBER_MAX_LENGTH + 1))).toBe(false)
    expect(isUsableGuideNumber(12_345)).toBe(false)
    expect(isUsableGuideNumber(undefined)).toBe(false)
  })
})

describe('the day a carrier comes', () => {
  // 2026-11-10 is a Tuesday (ISO weekday 2), in San Salvador (UTC-6, no daylight time)
  const tuesdayNoon = new Date('2026-11-10T18:00:00.000Z')
  const zone = 'America/El_Salvador'

  it('reads the wall clock of an instant in a time zone', () => {
    expect(wallClockOf(tuesdayNoon, zone)).toEqual({
      weekday: 2,
      date: '2026-11-10',
      time: '12:00'
    })
    // The same instant is already tomorrow in Tokyo
    expect(wallClockOf(new Date('2026-11-10T20:00:00.000Z'), 'Asia/Tokyo')).toMatchObject({
      weekday: 3,
      date: '2026-11-11'
    })
  })

  it('takes today while the cutoff has not passed, and the next valid day after it', () => {
    const rules = { pickupDays: [1, 2, 3, 4, 5], pickupCutoffTime: '15:00' }
    expect(nextPickupDate(tuesdayNoon, zone, rules)).toBe('2026-11-10')
    expect(nextPickupDate(new Date('2026-11-10T22:00:00.000Z'), zone, rules)).toBe('2026-11-11')
  })

  it('skips the days that are not in the list', () => {
    // Fridays only: the next one after a Tuesday is the 13th
    expect(nextPickupDate(tuesdayNoon, zone, { pickupDays: [5], pickupCutoffTime: null })).toBe(
      '2026-11-13'
    )
  })

  it('has no day when the connection lists none', () => {
    expect(nextPickupDate(tuesdayNoon, zone, { pickupDays: [], pickupCutoffTime: null })).toBeNull()
  })
})

describe('rateServiceOf', () => {
  const guide = { shippingPayer: ShippingPayer.SENDER, cod: true, serviceCode: 'standard' }
  const withRate = (rateServiceOf: () => unknown) => ({
    feeSettings: { commission: true, rateServices: [], rateServiceOf: rateServiceOf as never }
  })
  it('is what the plugin says', () => {
    expect(
      rateServiceOf(
        withRate(() => 'CCE'),
        guide
      )
    ).toBe('CCE')
  })
  it('is null when the plugin declares no fee settings, throws, or answers with what is not a code', () => {
    expect(rateServiceOf({}, guide)).toBeNull()
    expect(
      rateServiceOf(
        withRate(() => {
          throw new Error('boom')
        }),
        guide
      )
    ).toBeNull()
    expect(
      rateServiceOf(
        withRate(() => 42),
        guide
      )
    ).toBeNull()
    expect(
      rateServiceOf(
        withRate(() => 'a b'),
        guide
      )
    ).toBeNull()
    expect(
      rateServiceOf(
        withRate(() => null),
        guide
      )
    ).toBeNull()
  })
})
