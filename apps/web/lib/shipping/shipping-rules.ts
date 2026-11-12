import {
  CarrierCapability,
  PickupStatus,
  ShipmentKind,
  ShipmentPrintableStatuses,
  ShipmentStatus,
  ShipmentStatusTransitions
} from '@platform/core/domain'

import { isKnown } from './known-value'

// What the Shipments and Pickups screens offer for one guide or pickup (TDD_17 §4.6, §4.8, §4.10). Pure: the permission and
// the capability of the connection decide, never the name of a carrier. The server decides again on every call.

export interface ShippingAbility {
  // `shipping:manage` and `shipping:manage_pickups`
  canManage: boolean
  canManagePickups: boolean
  // What the connection of the guide or pickup declares; `null` while it is not known (not read yet): nothing is then said about
  // what the carrier can or cannot do, and the server decides
  capabilities: readonly string[] | null
}

export interface GuideFacts {
  status: string
  kind: string
  hasLabel: boolean
  guideNumber: string | null
}

export interface GuideActions {
  label: boolean
  // Void the guide. Without a carrier that can be asked, the guide is voided here only and the agent voids it with the carrier
  cancel: boolean
  cancelIsLocalOnly: boolean
  markVoided: boolean
  // Ask the carrier whether it has the guide (outcome unknown)
  check: boolean
  // Settle a guide of unknown outcome by hand: found (needs its number) or failed
  settle: boolean
}

const NONE: GuideActions = {
  label: false,
  cancel: false,
  cancelIsLocalOnly: false,
  markVoided: false,
  check: false,
  settle: false
}

export function guideActions(guide: GuideFacts, ability: ShippingAbility): GuideActions {
  if (!ability.canManage || !isKnown(ShipmentStatus, guide.status)) return NONE
  const status = guide.status
  const hasCancelStep = ShipmentStatusTransitions[status].includes(ShipmentStatus.CANCEL_PENDING)
  const carrierCanVoid =
    ability.capabilities === null ||
    ability.capabilities.includes(CarrierCapability.CANCEL_SHIPMENT) ||
    ability.capabilities.includes(CarrierCapability.INTERNAL_GUIDE)
  const unknown = status === ShipmentStatus.REQUIRES_REVIEW
  return {
    label: guide.hasLabel && ShipmentPrintableStatuses.includes(status),
    cancel: hasCancelStep,
    cancelIsLocalOnly: hasCancelStep && !carrierCanVoid,
    markVoided: status === ShipmentStatus.CANCEL_FAILED,
    // A return guide is asked by a reference that could find the outbound one: the api refuses it, so it is not offered
    check: unknown && guide.kind === String(ShipmentKind.OUTBOUND),
    settle: unknown
  }
}

export interface PickupFacts {
  status: string
}

export interface PickupActions {
  // Put guides in, or take one out
  edit: boolean
  confirm: boolean
  cancel: boolean
  // The pickup is held by a carrier that cannot be asked to cancel it: the agent cancels it with the carrier
  cancelWithCarrier: boolean
  // The agent asked the carrier by hand, or has to
  manifest: boolean
  needsPerson: boolean
}

const NO_PICKUP: PickupActions = {
  edit: false,
  confirm: false,
  cancel: false,
  cancelWithCarrier: false,
  manifest: false,
  needsPerson: false
}

export function pickupActions(pickup: PickupFacts, ability: ShippingAbility): PickupActions {
  if (!isKnown(PickupStatus, pickup.status)) return NO_PICKUP
  const status = pickup.status
  const heldByCarrier = status === PickupStatus.REQUESTED || status === PickupStatus.CONFIRMED
  const known = ability.capabilities
  const canModify = known?.includes(CarrierCapability.PICKUP_MODIFY) === true
  // Not read yet: the cancel is offered (the server refuses a carrier that cannot) and nothing is said against it
  const canCancelAtCarrier = known === null || known.includes(CarrierCapability.PICKUP_CANCEL)
  const open = status !== PickupStatus.CANCELLED && status !== PickupStatus.FAILED
  const manage = ability.canManagePickups
  return {
    // A pickup the carrier holds takes a change only where the carrier can modify it; one that waits for a person always does
    edit: manage && (status === PickupStatus.MANUAL_REQUIRED || (heldByCarrier && canModify)),
    confirm:
      manage && (status === PickupStatus.MANUAL_REQUIRED || status === PickupStatus.REQUESTED),
    cancel:
      manage && open && status !== PickupStatus.PENDING && (!heldByCarrier || canCancelAtCarrier),
    cancelWithCarrier: manage && heldByCarrier && !canCancelAtCarrier,
    manifest: open,
    needsPerson: status === PickupStatus.MANUAL_REQUIRED || status === PickupStatus.REQUIRES_REVIEW
  }
}

// The guides that can join a pickup of a connection: made, still waiting (no pickup), outbound, of that connection
export function isEligibleForPickup(
  guide: { status: string; kind: string; pickupId: string | null; connectionId: string },
  connectionId: string
): boolean {
  return (
    guide.status === String(ShipmentStatus.LABEL_CREATED) &&
    guide.kind === String(ShipmentKind.OUTBOUND) &&
    guide.pickupId === null &&
    guide.connectionId === connectionId
  )
}
