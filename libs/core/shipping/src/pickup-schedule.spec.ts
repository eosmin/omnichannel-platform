import {
  cutoffReminderDue,
  isAutoPickupDue,
  minutesToCutoff,
  type PickupScheduleRules,
  storeClockOf
} from './pickup-schedule'

const ZONE = 'America/El_Salvador' // UTC-6
// 2026-11-12 is a Thursday (4); 14:30 UTC is 08:30 in the store
const at = (hhmm: string, day = '2026-11-12'): Date => {
  const [h, m] = hhmm.split(':').map(Number)
  const [year, month, date] = day.split('-').map(Number)
  // The store is six hours behind UTC; the hour may roll into the next UTC day
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1, (h ?? 0) + 6, m ?? 0))
}
const RULES: PickupScheduleRules = {
  pickupDays: [1, 2, 3, 4, 5],
  pickupCutoffTime: '15:00',
  autoPickup: true,
  autoPickupTime: '10:00',
  pickupReminderMinutes: 30
}
const clock = (hhmm: string, day?: string) => storeClockOf(at(hhmm, day), ZONE)

describe('isAutoPickupDue', () => {
  it('is false before the auto-request time, true from it until the cutoff, false from the cutoff', () => {
    expect(isAutoPickupDue(RULES, clock('09:59'))).toBe(false)
    expect(isAutoPickupDue(RULES, clock('10:00'))).toBe(true)
    expect(isAutoPickupDue(RULES, clock('14:59'))).toBe(true)
    expect(isAutoPickupDue(RULES, clock('15:00'))).toBe(false)
  })

  it('is false on a day the carrier does not come', () => {
    // 2026-11-14 is a Saturday
    expect(isAutoPickupDue(RULES, clock('11:00', '2026-11-14'))).toBe(false)
  })

  it('is false when auto requests are off or have no time, and has no end without a cutoff', () => {
    expect(isAutoPickupDue({ ...RULES, autoPickup: false }, clock('11:00'))).toBe(false)
    expect(isAutoPickupDue({ ...RULES, autoPickupTime: null }, clock('11:00'))).toBe(false)
    expect(isAutoPickupDue({ ...RULES, pickupCutoffTime: null }, clock('23:30'))).toBe(true)
  })
})

describe('cutoffReminderDue', () => {
  it('is due inside the window before the cutoff and says how long is left', () => {
    expect(cutoffReminderDue(RULES, clock('14:30'))).toEqual({ minutesLeft: 30 })
    expect(cutoffReminderDue(RULES, clock('14:59'))).toEqual({ minutesLeft: 1 })
  })

  it('is not due before the window, at the cutoff or after it', () => {
    expect(cutoffReminderDue(RULES, clock('14:29'))).toBeNull()
    expect(cutoffReminderDue(RULES, clock('15:00'))).toBeNull()
    expect(cutoffReminderDue(RULES, clock('16:00'))).toBeNull()
  })

  it('is not due without a cutoff or on a day the carrier does not come', () => {
    expect(cutoffReminderDue({ ...RULES, pickupCutoffTime: null }, clock('14:45'))).toBeNull()
    expect(cutoffReminderDue(RULES, clock('14:45', '2026-11-14'))).toBeNull()
  })
})

describe('minutesToCutoff', () => {
  it('counts to the cutoff, and is null without one', () => {
    expect(minutesToCutoff(RULES, clock('13:15'))).toBe(105)
    expect(minutesToCutoff({ ...RULES, pickupCutoffTime: null }, clock('13:15'))).toBeNull()
  })
})
