import { CarrierCapability, OrderStatus, ShipmentKind, ShipmentStatus } from '@platform/core/domain'

import {
  asShipmentStatus,
  carrierCancels,
  GuideBlocks,
  guideBlockOf,
  liveOutbound,
  offeredShipmentActions,
  outboundStatusesOf,
  ShipmentActions,
  takesPickupRequests
} from './order-shipping-rules'

const offer = (
  status: string,
  extra: Partial<Parameters<typeof offeredShipmentActions>[0]> = {}
): string[] =>
  offeredShipmentActions({
    status,
    kind: ShipmentKind.OUTBOUND,
    hasLabel: true,
    mayManage: true,
    pickupId: null,
    mayRequestPickup: false,
    carrierTakesPickups: null,
    carrierCanCancel: true,
    ...extra
  })

describe('offeredShipmentActions', () => {
  it('offers nothing without shipping:manage or for a status it does not know', () => {
    expect(offer(ShipmentStatus.LABEL_CREATED, { mayManage: false })).toEqual([])
    expect(offer('mystery')).toEqual([])
  })

  it('prints and cancels a guide that was made', () => {
    expect(offer(ShipmentStatus.LABEL_CREATED)).toEqual([
      ShipmentActions.PRINT_LABEL,
      ShipmentActions.CANCEL
    ])
  })

  it('does not print a guide with no label or a voided one', () => {
    expect(offer(ShipmentStatus.LABEL_CREATED, { hasLabel: false })).toEqual([
      ShipmentActions.CANCEL
    ])
    expect(offer(ShipmentStatus.CANCELLED)).toEqual([])
  })

  it('leaves a guide that is on its way alone', () => {
    expect(offer(ShipmentStatus.IN_TRANSIT)).toEqual([ShipmentActions.PRINT_LABEL])
  })

  it('offers a retry and a manual void of a cancel that failed', () => {
    expect(offer(ShipmentStatus.CANCEL_FAILED)).toEqual([
      ShipmentActions.PRINT_LABEL,
      ShipmentActions.CANCEL,
      ShipmentActions.MARK_VOIDED
    ])
  })

  it('offers the cancel, not the manual void, on a made guide of a carrier that cannot cancel', () => {
    // The api has no move from label_created to cancelled by hand: the cancel parks the guide as cancel_failed first
    expect(offer(ShipmentStatus.LABEL_CREATED, { carrierCanCancel: false })).toEqual([
      ShipmentActions.PRINT_LABEL,
      ShipmentActions.CANCEL
    ])
  })

  it('offers only the manual void of a cancel that failed at a carrier that cannot cancel', () => {
    expect(offer(ShipmentStatus.CANCEL_FAILED, { carrierCanCancel: false })).toEqual([
      ShipmentActions.PRINT_LABEL,
      ShipmentActions.MARK_VOIDED
    ])
  })

  it('offers neither while a cancel is pending', () => {
    expect(offer(ShipmentStatus.CANCEL_PENDING)).toEqual([ShipmentActions.PRINT_LABEL])
  })
})

describe('carrierCancels', () => {
  it('reads a carrier that is asked or a guide of the platform as able to cancel', () => {
    expect(carrierCancels([CarrierCapability.CANCEL_SHIPMENT])).toBe(true)
    expect(carrierCancels([CarrierCapability.INTERNAL_GUIDE, CarrierCapability.COD])).toBe(true)
  })
  it('refuses a carrier that declares neither', () => {
    expect(carrierCancels([CarrierCapability.COD])).toBe(false)
    expect(carrierCancels([])).toBe(false)
  })
  it('offers the cancel, and not the manual void, for a made guide of a platform courier', () => {
    const actions = offeredShipmentActions({
      status: ShipmentStatus.LABEL_CREATED,
      kind: ShipmentKind.OUTBOUND,
      hasLabel: true,
      mayManage: true,
      pickupId: null,
      mayRequestPickup: false,
      carrierTakesPickups: false,
      carrierCanCancel: carrierCancels([CarrierCapability.INTERNAL_GUIDE])
    })
    expect(actions).toContain(ShipmentActions.CANCEL)
    expect(actions).not.toContain(ShipmentActions.MARK_VOIDED)
  })
})

describe('liveOutbound and outboundStatusesOf', () => {
  const shipments = [
    { kind: ShipmentKind.OUTBOUND, status: ShipmentStatus.CANCELLED },
    { kind: ShipmentKind.OUTBOUND, status: ShipmentStatus.FAILED },
    { kind: ShipmentKind.OUTBOUND, status: ShipmentStatus.IN_TRANSIT },
    { kind: ShipmentKind.RETURN, status: ShipmentStatus.LABEL_CREATED }
  ]
  it('keeps the guides that still count', () => {
    expect(liveOutbound(shipments)).toEqual([shipments[2]])
  })
  it('lists the statuses of the outbound guides only', () => {
    expect(outboundStatusesOf(shipments)).toEqual(['cancelled', 'failed', 'in_transit'])
  })
  it('knows a status or says it does not', () => {
    expect(asShipmentStatus('delivered')).toBe(ShipmentStatus.DELIVERED)
    expect(asShipmentStatus('x')).toBeNull()
  })
})

describe('guideBlockOf', () => {
  const order: {
    status: string
    priceApprovalStatus: string
    shippingAddress: unknown
    recipientPhones: string[]
  } = {
    status: OrderStatus.CONFIRMED,
    priceApprovalStatus: 'not_required',
    shippingAddress: { line1: 'Calle 1', city: 'San Salvador', country: 'SV' },
    recipientPhones: ['70001111']
  }
  const base = { order, shipments: [] as { kind: string; status: string }[] }

  it('is free for a confirmed order with address, phone and no guide', () => {
    expect(guideBlockOf(base)).toBeNull()
    expect(guideBlockOf({ ...base, order: { ...order, status: OrderStatus.PREPARING } })).toBeNull()
  })

  it('says what keeps the order from a guide, in the order the api checks', () => {
    const block = (over: Partial<typeof order>) =>
      guideBlockOf({ ...base, order: { ...order, ...over } })
    expect(block({ status: OrderStatus.SHIPPED })).toBe(GuideBlocks.NOT_CONFIRMED)
    expect(block({ priceApprovalStatus: 'pending' })).toBe(GuideBlocks.PRICE_APPROVAL)
    expect(block({ shippingAddress: null })).toBe(GuideBlocks.NO_ADDRESS)
    expect(block({ recipientPhones: [] })).toBe(GuideBlocks.NO_PHONE)
  })

  it('is blocked by a live guide or one whose outcome is unknown, not by a voided one', () => {
    const with_ = (status: ShipmentStatus) =>
      guideBlockOf({ ...base, shipments: [{ kind: ShipmentKind.OUTBOUND, status }] })
    expect(with_(ShipmentStatus.LABEL_CREATED)).toBe(GuideBlocks.HAS_GUIDE)
    expect(with_(ShipmentStatus.REQUIRES_REVIEW)).toBe(GuideBlocks.HAS_GUIDE)
    expect(with_(ShipmentStatus.CANCELLED)).toBeNull()
    expect(with_(ShipmentStatus.FAILED)).toBeNull()
  })
})

describe('requesting a pickup from a guide', () => {
  const ask = { mayRequestPickup: true, carrierTakesPickups: true }

  it('is offered for a made guide with no pickup at a carrier that takes requests, to who manages pickups', () => {
    expect(offer(ShipmentStatus.LABEL_CREATED, ask)).toContain(ShipmentActions.REQUEST_PICKUP)
  })

  it('does not need shipping:manage, and needs shipping:manage_pickups', () => {
    expect(offer(ShipmentStatus.LABEL_CREATED, { ...ask, mayManage: false })).toEqual([
      ShipmentActions.REQUEST_PICKUP
    ])
    expect(offer(ShipmentStatus.LABEL_CREATED, { ...ask, mayRequestPickup: false })).not.toContain(
      ShipmentActions.REQUEST_PICKUP
    )
  })

  it('is not offered for the guide of the way back', () => {
    expect(
      offer(ShipmentStatus.LABEL_CREATED, { ...ask, kind: ShipmentKind.RETURN })
    ).not.toContain(ShipmentActions.REQUEST_PICKUP)
  })

  it('is not offered when the guide is in a pickup, is not just made, or the carrier does not take requests', () => {
    expect(offer(ShipmentStatus.LABEL_CREATED, { ...ask, pickupId: 'p1' })).not.toContain(
      ShipmentActions.REQUEST_PICKUP
    )
    expect(offer(ShipmentStatus.IN_TRANSIT, ask)).not.toContain(ShipmentActions.REQUEST_PICKUP)
    for (const carrierTakesPickups of [false, null]) {
      expect(offer(ShipmentStatus.LABEL_CREATED, { ...ask, carrierTakesPickups })).not.toContain(
        ShipmentActions.REQUEST_PICKUP
      )
    }
  })
})

describe('takesPickupRequests', () => {
  it('needs the pickup enabled, the capability to request and a carrier whose guides are not bound to the pickup', () => {
    const request = [CarrierCapability.PICKUP_REQUEST]
    expect(takesPickupRequests({ pickupEnabled: true, capabilities: request })).toBe(true)
    expect(takesPickupRequests({ pickupEnabled: false, capabilities: request })).toBe(false)
    expect(takesPickupRequests({ pickupEnabled: true, capabilities: [] })).toBe(false)
    expect(
      takesPickupRequests({
        pickupEnabled: true,
        capabilities: [...request, CarrierCapability.PICKUP_BOUND_GUIDES]
      })
    ).toBe(false)
  })
})
