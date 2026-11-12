import { PickupStatus, PickupWaitReasons } from '@platform/core/domain'

import {
  decideJoin,
  isPickupCutoffPassed,
  pickupNeedsSync,
  resolvePickupDate
} from './pickup-rules'

const ZONE = 'America/El_Salvador' // UTC-6, no daylight saving
// 2026-11-12 is a Thursday (ISO weekday 4); 14:30 UTC is 08:30 in the zone
const THURSDAY_0830 = new Date('2026-11-12T14:30:00.000Z')
const THURSDAY_1630 = new Date('2026-11-12T22:30:00.000Z')
const WEEKDAYS = { pickupDays: [1, 2, 3, 4, 5], pickupCutoffTime: '15:00' }

describe('isPickupCutoffPassed', () => {
  it('is false before the cutoff of the day, and at the very minute of it', () => {
    expect(isPickupCutoffPassed(THURSDAY_0830, ZONE, '2026-11-12', '15:00')).toBe(false)
    expect(
      isPickupCutoffPassed(new Date('2026-11-12T21:00:00.000Z'), ZONE, '2026-11-12', '15:00')
    ).toBe(false)
  })

  it('is true once the clock of the store is past the cutoff', () => {
    expect(isPickupCutoffPassed(THURSDAY_1630, ZONE, '2026-11-12', '15:00')).toBe(true)
  })

  it('reads the day in the zone of the store, not in UTC', () => {
    // 03:00 UTC of the 13th is still 21:00 of the 12th in the store
    const late = new Date('2026-11-13T03:00:00.000Z')
    expect(isPickupCutoffPassed(late, ZONE, '2026-11-12', '23:59')).toBe(false)
    expect(isPickupCutoffPassed(late, ZONE, '2026-11-12', '20:00')).toBe(true)
  })

  it('never closes a pickup of a coming day, always closes one of a past day, and a pickup with no cutoff stays open all day', () => {
    expect(isPickupCutoffPassed(THURSDAY_1630, ZONE, '2026-11-13', '09:00')).toBe(false)
    expect(isPickupCutoffPassed(THURSDAY_0830, ZONE, '2026-11-11', null)).toBe(true)
    expect(isPickupCutoffPassed(THURSDAY_1630, ZONE, '2026-11-12', null)).toBe(false)
  })
})

describe('resolvePickupDate', () => {
  it('takes today before the cutoff and the next pickup day after it', () => {
    expect(resolvePickupDate(THURSDAY_0830, ZONE, WEEKDAYS, undefined)).toEqual({
      date: '2026-11-12'
    })
    // Friday is a pickup day
    expect(resolvePickupDate(THURSDAY_1630, ZONE, WEEKDAYS, undefined)).toEqual({
      date: '2026-11-13'
    })
  })

  it('refuses a connection with no pickup day', () => {
    expect(
      resolvePickupDate(THURSDAY_0830, ZONE, { ...WEEKDAYS, pickupDays: [] }, undefined)
    ).toEqual({
      refusal: 'no_days'
    })
    expect(
      resolvePickupDate(THURSDAY_0830, ZONE, { ...WEEKDAYS, pickupDays: [] }, '2026-11-13')
    ).toEqual({ refusal: 'no_days' })
  })

  it('takes the day asked for when it is a pickup day that is not over', () => {
    expect(resolvePickupDate(THURSDAY_0830, ZONE, WEEKDAYS, '2026-11-16')).toEqual({
      date: '2026-11-16'
    })
    expect(resolvePickupDate(THURSDAY_0830, ZONE, WEEKDAYS, '2026-11-12')).toEqual({
      date: '2026-11-12'
    })
  })

  it('refuses a day that is over and a day the carrier does not come', () => {
    expect(resolvePickupDate(THURSDAY_0830, ZONE, WEEKDAYS, '2026-11-11')).toEqual({
      refusal: 'in_the_past'
    })
    // 2026-11-14 is a Saturday
    expect(resolvePickupDate(THURSDAY_0830, ZONE, WEEKDAYS, '2026-11-14')).toEqual({
      refusal: 'not_a_pickup_day'
    })
  })
})

describe('decideJoin', () => {
  const held = {
    providerPickupId: 'P-1',
    canModify: true,
    cutoffPassed: false,
    confirmedAfterCutoff: false
  }

  it('adds to a pickup that nobody has asked a carrier for, and to one arranged by hand, even after the cutoff', () => {
    for (const status of [PickupStatus.PENDING, PickupStatus.MANUAL_REQUIRED]) {
      expect(decideJoin({ ...held, status, providerPickupId: null, cutoffPassed: true })).toEqual({
        kind: 'join',
        tellCarrier: false
      })
    }
  })

  it('adds to a pickup the carrier holds and tells the carrier, when the carrier can change the count', () => {
    for (const status of [PickupStatus.REQUESTED, PickupStatus.CONFIRMED]) {
      expect(decideJoin({ ...held, status })).toEqual({ kind: 'join', tellCarrier: true })
    }
  })

  it('leaves the guide waiting for the next day when the carrier cannot change a count, or never gave a reference', () => {
    expect(decideJoin({ ...held, status: PickupStatus.REQUESTED, canModify: false })).toEqual({
      kind: 'wait',
      reason: PickupWaitReasons.CARRIER_CANNOT_MODIFY
    })
    expect(decideJoin({ ...held, status: PickupStatus.CONFIRMED, providerPickupId: null })).toEqual(
      { kind: 'wait', reason: PickupWaitReasons.CARRIER_CANNOT_MODIFY }
    )
  })

  it('refuses a change after the cutoff unless a person confirmed it', () => {
    expect(decideJoin({ ...held, status: PickupStatus.REQUESTED, cutoffPassed: true })).toEqual({
      kind: 'cutoff'
    })
    expect(
      decideJoin({
        ...held,
        status: PickupStatus.REQUESTED,
        cutoffPassed: true,
        confirmedAfterCutoff: true
      })
    ).toEqual({ kind: 'join', tellCarrier: true })
  })

  it('takes nothing into a pickup whose outcome is unknown, and nothing into one that is over', () => {
    for (const status of [
      PickupStatus.REQUIRES_REVIEW,
      PickupStatus.FAILED,
      PickupStatus.CANCELLED
    ]) {
      expect(decideJoin({ ...held, status })).toEqual({
        kind: 'wait',
        reason: PickupWaitReasons.UNDER_REVIEW
      })
    }
  })
})

describe('pickupNeedsSync', () => {
  const base = {
    status: PickupStatus.REQUESTED,
    providerPickupId: 'P-1',
    packageCount: 3,
    carrierPackageCount: 2
  }

  it('is true when the carrier holds the pickup with another count than the guides hold', () => {
    expect(pickupNeedsSync(base)).toBe(true)
    expect(pickupNeedsSync({ ...base, status: PickupStatus.CONFIRMED })).toBe(true)
  })

  it('is false when the two agree, when the carrier never heard of the pickup, or when it never recorded a count', () => {
    expect(pickupNeedsSync({ ...base, carrierPackageCount: 3 })).toBe(false)
    expect(pickupNeedsSync({ ...base, providerPickupId: null })).toBe(false)
    expect(pickupNeedsSync({ ...base, carrierPackageCount: null })).toBe(false)
  })

  it('is false for a pickup the carrier does not hold', () => {
    for (const status of [
      PickupStatus.PENDING,
      PickupStatus.MANUAL_REQUIRED,
      PickupStatus.REQUIRES_REVIEW,
      PickupStatus.CANCELLED,
      PickupStatus.FAILED
    ]) {
      expect(pickupNeedsSync({ ...base, status })).toBe(false)
    }
  })
})
