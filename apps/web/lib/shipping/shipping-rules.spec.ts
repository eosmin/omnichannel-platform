import { CarrierCapability, PickupStatus, ShipmentStatus } from '@platform/core/domain'

import { guideActions, isEligibleForPickup, pickupActions } from './shipping-rules'

const can = { canManage: true, canManagePickups: true, capabilities: [] as string[] }
const guide = (status: string, over: Partial<{ kind: string; hasLabel: boolean }> = {}) => ({
  status,
  kind: 'outbound',
  hasLabel: true,
  guideNumber: 'G-1',
  ...over
})

describe('guideActions', () => {
  it('offers nothing without shipping:manage', () => {
    expect(guideActions(guide(ShipmentStatus.LABEL_CREATED), { ...can, canManage: false })).toEqual(
      {
        label: false,
        cancel: false,
        cancelIsLocalOnly: false,
        markVoided: false,
        check: false,
        settle: false
      }
    )
  })

  it('offers nothing for a status it does not know (a newer server)', () => {
    expect(guideActions(guide('teleported'), can).cancel).toBe(false)
  })

  it('prints only a guide made and not voided that has its label', () => {
    expect(guideActions(guide(ShipmentStatus.LABEL_CREATED), can).label).toBe(true)
    expect(guideActions(guide(ShipmentStatus.LABEL_CREATED, { hasLabel: false }), can).label).toBe(
      false
    )
    expect(guideActions(guide(ShipmentStatus.CANCELLED), can).label).toBe(false)
    expect(guideActions(guide(ShipmentStatus.REQUIRES_REVIEW), can).label).toBe(false)
  })

  it('cancels where the table has a cancel step, and says when only this store voids it', () => {
    const local = guideActions(guide(ShipmentStatus.LABEL_CREATED), can)
    expect(local.cancel).toBe(true)
    expect(local.cancelIsLocalOnly).toBe(true)
    const asked = guideActions(guide(ShipmentStatus.LABEL_CREATED), {
      ...can,
      capabilities: [CarrierCapability.CANCEL_SHIPMENT]
    })
    expect(asked.cancelIsLocalOnly).toBe(false)
    expect(guideActions(guide(ShipmentStatus.DELIVERED), can).cancel).toBe(false)
    expect(guideActions(guide(ShipmentStatus.CANCELLED), can).cancel).toBe(false)
  })

  it('offers "mark as voided" only after a cancel the carrier did not take', () => {
    expect(guideActions(guide(ShipmentStatus.CANCEL_FAILED), can).markVoided).toBe(true)
    expect(guideActions(guide(ShipmentStatus.CANCEL_PENDING), can).markVoided).toBe(false)
  })

  it('settles a guide of unknown outcome, and asks the carrier only for an outbound one', () => {
    const outbound = guideActions(guide(ShipmentStatus.REQUIRES_REVIEW), can)
    expect(outbound.settle).toBe(true)
    expect(outbound.check).toBe(true)
    const back = guideActions(guide(ShipmentStatus.REQUIRES_REVIEW, { kind: 'return' }), can)
    expect(back.settle).toBe(true)
    expect(back.check).toBe(false)
    expect(guideActions(guide(ShipmentStatus.LABEL_CREATED), can).settle).toBe(false)
  })
})

describe('capabilities not read yet (null)', () => {
  const unknown = { ...can, capabilities: null }

  it('says nothing against the carrier for a guide: the cancel is not called local-only', () => {
    const view = guideActions(guide(ShipmentStatus.LABEL_CREATED), unknown)
    expect(view.cancel).toBe(true)
    expect(view.cancelIsLocalOnly).toBe(false)
  })

  it('offers to cancel a pickup the carrier holds and does not tell to cancel it with the carrier', () => {
    const view = pickupActions({ status: PickupStatus.CONFIRMED }, unknown)
    expect(view.cancel).toBe(true)
    expect(view.cancelWithCarrier).toBe(false)
    expect(view.edit).toBe(false)
  })
})

describe('pickupActions', () => {
  const held = {
    ...can,
    capabilities: [CarrierCapability.PICKUP_MODIFY, CarrierCapability.PICKUP_CANCEL]
  }

  it('offers nothing to change without shipping:manage_pickups, but the manifest stays', () => {
    const view = pickupActions(
      { status: PickupStatus.MANUAL_REQUIRED },
      { ...can, canManagePickups: false }
    )
    expect(view).toMatchObject({ edit: false, confirm: false, cancel: false, manifest: true })
  })

  it('lets a pickup that waits for a person be edited, confirmed and cancelled', () => {
    expect(pickupActions({ status: PickupStatus.MANUAL_REQUIRED }, can)).toMatchObject({
      edit: true,
      confirm: true,
      cancel: true,
      needsPerson: true
    })
  })

  it('edits a pickup the carrier holds only where the carrier can modify it', () => {
    expect(pickupActions({ status: PickupStatus.REQUESTED }, can).edit).toBe(false)
    expect(pickupActions({ status: PickupStatus.REQUESTED }, held).edit).toBe(true)
  })

  it('does not offer to cancel at a carrier that cannot cancel, and says so', () => {
    const view = pickupActions({ status: PickupStatus.CONFIRMED }, can)
    expect(view.cancel).toBe(false)
    expect(view.cancelWithCarrier).toBe(true)
    const ok = pickupActions({ status: PickupStatus.CONFIRMED }, held)
    expect(ok.cancel).toBe(true)
    expect(ok.cancelWithCarrier).toBe(false)
  })

  it('lets an unsettled pickup be ended, never one that is being asked or is over', () => {
    expect(pickupActions({ status: PickupStatus.REQUIRES_REVIEW }, can)).toMatchObject({
      cancel: true,
      needsPerson: true,
      confirm: false
    })
    expect(pickupActions({ status: PickupStatus.PENDING }, held).cancel).toBe(false)
    expect(pickupActions({ status: PickupStatus.CANCELLED }, held)).toMatchObject({
      cancel: false,
      manifest: false
    })
    expect(pickupActions({ status: PickupStatus.FAILED }, held).manifest).toBe(false)
  })

  it('offers nothing for a status it does not know', () => {
    expect(pickupActions({ status: 'later' }, held).cancel).toBe(false)
  })
})

describe('isEligibleForPickup', () => {
  const base = { status: 'label_created', kind: 'outbound', pickupId: null, connectionId: 'c1' }
  it('takes a made, outbound guide of the connection that is in no pickup', () => {
    expect(isEligibleForPickup(base, 'c1')).toBe(true)
    expect(isEligibleForPickup({ ...base, pickupId: 'p1' }, 'c1')).toBe(false)
    expect(isEligibleForPickup(base, 'c2')).toBe(false)
    expect(isEligibleForPickup({ ...base, kind: 'return' }, 'c1')).toBe(false)
    expect(isEligibleForPickup({ ...base, status: 'in_transit' }, 'c1')).toBe(false)
  })
})
