import {
  PickupStatus,
  PickupWaitReasons,
  type PickupWaitReason,
  ShipmentStatus
} from '@platform/core/domain'

import { nextPickupDate, type PickupRules, wallClockOf } from './shipment-rules'

// The decisions of a pickup that need no database (TDD_17 §4.10): which day, whether the cutoff passed, whether a guide may join a
// pickup that exists, and whether the carrier has to be told again. The service applies them under its lock.

// A shipment that may be offered to a pickup: a guide that exists and is still only a label
export const PickupEligibleStatuses: readonly ShipmentStatus[] = [ShipmentStatus.LABEL_CREATED]

// The cutoff of a pickup date has passed: the date is over, or it is today and the time of the store is past the cutoff. A pickup
// without a cutoff never closes during its day.
export function isPickupCutoffPassed(
  now: Date,
  timeZone: string,
  pickupDate: string,
  cutoffTime: string | null
): boolean {
  const today = wallClockOf(now, timeZone)
  if (pickupDate < today.date) return true
  return pickupDate === today.date && cutoffTime !== null && today.time > cutoffTime
}

export type PickupDateRefusal = 'no_days' | 'in_the_past' | 'not_a_pickup_day'

// The day of a pickup: the one asked for, which must not be over and must be a day the connection takes pickups, or the next valid
// day of the connection
export function resolvePickupDate(
  now: Date,
  timeZone: string,
  rules: PickupRules,
  requested: string | undefined
): { date: string } | { refusal: PickupDateRefusal } {
  if (rules.pickupDays.length === 0) return { refusal: 'no_days' }
  if (requested === undefined) {
    const next = nextPickupDate(now, timeZone, rules)
    return next === null ? { refusal: 'no_days' } : { date: next }
  }
  if (requested < wallClockOf(now, timeZone).date) return { refusal: 'in_the_past' }
  // Noon UTC is the same calendar day in every timezone the weekday of a date is read in
  const weekday = wallClockOf(new Date(`${requested}T12:00:00.000Z`), 'UTC').weekday
  return rules.pickupDays.includes(weekday) ? { date: requested } : { refusal: 'not_a_pickup_day' }
}

export type JoinDecision =
  // Added to the pickup; `tellCarrier` when the carrier holds it and has to hear the new count
  | { kind: 'join'; tellCarrier: boolean }
  | { kind: 'wait'; reason: PickupWaitReason }
  // The change of a pickup of today after its cutoff, which a person confirms (`PICKUP_CUTOFF_PASSED`)
  | { kind: 'cutoff' }

// May a guide join the pickup that exists for its day? A pickup nobody has asked a carrier for, or one a person arranges by hand,
// takes it. One the carrier holds takes it only when the carrier can change the count, and not after the cutoff unless a person
// confirmed it. One whose outcome is unknown takes nothing until it is settled.
export function decideJoin(input: {
  status: PickupStatus
  providerPickupId: string | null
  canModify: boolean
  cutoffPassed: boolean
  confirmedAfterCutoff: boolean
}): JoinDecision {
  switch (input.status) {
    case PickupStatus.PENDING:
    case PickupStatus.MANUAL_REQUIRED:
      return { kind: 'join', tellCarrier: false }
    case PickupStatus.REQUESTED:
    case PickupStatus.CONFIRMED:
      if (!input.canModify || input.providerPickupId === null) {
        return { kind: 'wait', reason: PickupWaitReasons.CARRIER_CANNOT_MODIFY }
      }
      if (input.cutoffPassed && !input.confirmedAfterCutoff) return { kind: 'cutoff' }
      return { kind: 'join', tellCarrier: true }
    default:
      return { kind: 'wait', reason: PickupWaitReasons.UNDER_REVIEW }
  }
}

// The carrier holds this pickup and its count is not the one the guides hold: it has to be told (the resync of TDD_17 §4.10).
// What it last acknowledged is `carrierPackageCount`; a pickup that never recorded one is taken as in agreement until it changes.
export function pickupNeedsSync(pickup: {
  status: PickupStatus
  providerPickupId: string | null
  packageCount: number
  carrierPackageCount: number | null
}): boolean {
  if (pickup.status !== PickupStatus.REQUESTED && pickup.status !== PickupStatus.CONFIRMED) {
    return false
  }
  if (pickup.providerPickupId === null || pickup.carrierPackageCount === null) return false
  return pickup.carrierPackageCount !== pickup.packageCount
}
