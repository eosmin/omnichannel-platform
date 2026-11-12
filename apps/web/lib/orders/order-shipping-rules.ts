import {
  CarrierCapability,
  OrderStatus,
  PriceApprovalStatus,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentStatus,
  ShipmentUnknownOutcomeStatuses
} from '@platform/core/domain'

import { readAddress } from './order-fields'

// What the Shipping panel of the order detail offers. The api decides every move; this draws what a guide accepts in its status and
// what the member holds (shipping:manage), and never names a carrier: what a connection can do comes from its capabilities.

const OUTBOUND: string = ShipmentKind.OUTBOUND
const FAILED: string = ShipmentStatus.FAILED
const CANCEL_FAILED_STATUS: string = ShipmentStatus.CANCEL_FAILED
const LABEL_CREATED_STATUS: string = ShipmentStatus.LABEL_CREATED
const CONFIRMED: string = OrderStatus.CONFIRMED
const PREPARING: string = OrderStatus.PREPARING
const APPROVAL_PENDING: string = PriceApprovalStatus.PENDING
const APPROVAL_REJECTED: string = PriceApprovalStatus.REJECTED
const INACTIVE: readonly string[] = ShipmentInactiveStatuses
const UNKNOWN_OUTCOME: readonly string[] = ShipmentUnknownOutcomeStatuses

export const ShipmentActions = {
  PRINT_LABEL: 'print_label',
  REQUEST_PICKUP: 'request_pickup',
  CANCEL: 'cancel',
  MARK_VOIDED: 'mark_voided'
} as const
export type ShipmentAction = (typeof ShipmentActions)[keyof typeof ShipmentActions]

// A carrier a pickup is asked of from the screens: it has an API for it and its guides do not travel inside the pickup itself
// (a pickup-bound carrier gets its pickup with the guides). By capability, never by the carrier's name.
export function takesPickupRequests(connection: {
  pickupEnabled: boolean
  capabilities: readonly string[]
}): boolean {
  return (
    connection.pickupEnabled &&
    connection.capabilities.includes(CarrierCapability.PICKUP_REQUEST) &&
    !connection.capabilities.includes(CarrierCapability.PICKUP_BOUND_GUIDES)
  )
}

const KNOWN_SHIPMENT_STATUSES: readonly string[] = Object.values(ShipmentStatus)

export const asShipmentStatus = (value: string): ShipmentStatus | null =>
  KNOWN_SHIPMENT_STATUSES.includes(value) ? (value as ShipmentStatus) : null

// A guide that may still be cancelled: made and not picked up, or a cancel that failed (retried)
const CANCELLABLE: readonly string[] = [LABEL_CREATED_STATUS, CANCEL_FAILED_STATUS]

// The moves of a guide. The label is read by whoever manages shipping while the guide exists. A guide made at a carrier that cannot
// cancel is voided by hand ("mark as voided": whoever made it tells the carrier); a cancel that failed offers both.
export function offeredShipmentActions(input: {
  status: string
  // A guide of the way back is picked up by the customer's side, never asked of the carrier from here
  kind: string
  hasLabel: boolean
  mayManage: boolean
  // The guide is not in a pickup yet, and the member holds shipping:manage_pickups
  pickupId: string | null
  mayRequestPickup: boolean
  // Whether the connection's carrier is asked for pickups from here (`takesPickupRequests`); null while the connections are not known
  carrierTakesPickups: boolean | null
  // Whether the connection's carrier can cancel a guide; null while the connections are not known
  carrierCanCancel: boolean | null
}): ShipmentAction[] {
  const status = asShipmentStatus(input.status)
  if (status === null) return []
  const actions: ShipmentAction[] = []
  // A pickup is asked for a guide that waits for it: made, with no pickup, at a carrier that takes requests
  if (
    input.mayRequestPickup &&
    input.kind === OUTBOUND &&
    input.status === LABEL_CREATED_STATUS &&
    input.pickupId === null &&
    input.carrierTakesPickups === true
  ) {
    actions.push(ShipmentActions.REQUEST_PICKUP)
  }
  if (!input.mayManage) return actions
  const live = !INACTIVE.includes(input.status) && input.status !== FAILED
  if (input.hasLabel && live) actions.push(ShipmentActions.PRINT_LABEL)
  if (CANCELLABLE.includes(input.status) && input.carrierCanCancel !== false) {
    actions.push(ShipmentActions.CANCEL)
  }
  if (
    input.status === CANCEL_FAILED_STATUS ||
    (input.status === LABEL_CREATED_STATUS && input.carrierCanCancel === false)
  ) {
    actions.push(ShipmentActions.MARK_VOIDED)
  }
  return actions
}

interface ShipmentLike {
  kind: string
  status: string
}

// The outbound guides that still count for the order: the ones that were voided, refused or came back do not
export function liveOutbound<T extends ShipmentLike>(shipments: readonly T[]): T[] {
  return shipments.filter(
    shipment =>
      shipment.kind === OUTBOUND &&
      !INACTIVE.includes(shipment.status) &&
      shipment.status !== FAILED
  )
}

// The status of the outbound guides, for the Returns panel (a return starts on an order whose guide is coming back)
export const outboundStatusesOf = (shipments: readonly ShipmentLike[]): string[] =>
  shipments.filter(shipment => shipment.kind === OUTBOUND).map(s => s.status)

// A guide whose outcome is unknown may exist at the carrier: nothing is made until someone resolves it
export const isUnknownOutcome = (status: string): boolean => UNKNOWN_OUTCOME.includes(status)

// The first thing that keeps an order from getting a guide, in the order the api checks it (null when none): the status, a price
// waiting for approval, a missing address or phone, a guide that is already live
export const GuideBlocks = {
  NOT_CONFIRMED: 'not_confirmed',
  PRICE_APPROVAL: 'price_approval',
  NO_ADDRESS: 'no_address',
  NO_PHONE: 'no_phone',
  HAS_GUIDE: 'has_guide'
} as const
export type GuideBlock = (typeof GuideBlocks)[keyof typeof GuideBlocks]

export function guideBlockOf(input: {
  order: {
    status: string
    priceApprovalStatus: string
    shippingAddress: unknown
    recipientPhones: readonly string[]
  }
  shipments: readonly ShipmentLike[]
}): GuideBlock | null {
  const { order } = input
  if (order.status !== CONFIRMED && order.status !== PREPARING) {
    return GuideBlocks.NOT_CONFIRMED
  }
  if (
    order.priceApprovalStatus === APPROVAL_PENDING ||
    order.priceApprovalStatus === APPROVAL_REJECTED
  ) {
    return GuideBlocks.PRICE_APPROVAL
  }
  if (readAddress(order.shippingAddress) === null) return GuideBlocks.NO_ADDRESS
  if (order.recipientPhones.length === 0) return GuideBlocks.NO_PHONE
  const all = input.shipments.filter(s => s.kind === OUTBOUND)
  if (liveOutbound(all).length > 0 || all.some(s => isUnknownOutcome(s.status))) {
    return GuideBlocks.HAS_GUIDE
  }
  return null
}
