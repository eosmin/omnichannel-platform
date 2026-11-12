import { wallClockOf } from './shipment-rules'

// The decisions of the pickup scheduler that need no database (TDD_17 §4.10). The scheduler looks at every connection once a minute
// with the clock of the store, and these say what is due now.

export interface PickupScheduleRules {
  pickupDays: readonly number[]
  // 'HH:mm' in the timezone of the store
  pickupCutoffTime: string | null
  autoPickup: boolean
  autoPickupTime: string | null
  pickupReminderMinutes: number
}

export interface StoreClock {
  weekday: number
  date: string
  time: string
}

export const storeClockOf = (now: Date, timeZone: string): StoreClock => wallClockOf(now, timeZone)

const minutesOf = (clock: string): number => {
  const [hours, minutes] = clock.split(':')
  return Number(hours) * 60 + Number(minutes)
}

// Time left to the cutoff of the day, in minutes; null when the connection has no cutoff
export function minutesToCutoff(rules: PickupScheduleRules, clock: StoreClock): number | null {
  return rules.pickupCutoffTime === null
    ? null
    : minutesOf(rules.pickupCutoffTime) - minutesOf(clock.time)
}

// "Today is a pickup day, now is at or after the auto-request time and before the cutoff" (TDD_17 §4.10). A connection with `autoPickup`
// and no time never runs by itself.
export function isAutoPickupDue(rules: PickupScheduleRules, clock: StoreClock): boolean {
  if (!rules.autoPickup || rules.autoPickupTime === null) return false
  if (!rules.pickupDays.includes(clock.weekday)) return false
  if (clock.time < rules.autoPickupTime) return false
  return rules.pickupCutoffTime === null || clock.time < rules.pickupCutoffTime
}

// The reminder window: `pickupReminderMinutes` before the cutoff of a pickup day, until the cutoff. The caller raises it once per
// day; this only says that the moment has come (and how long is left).
export function cutoffReminderDue(
  rules: PickupScheduleRules,
  clock: StoreClock
): { minutesLeft: number } | null {
  if (!rules.pickupDays.includes(clock.weekday)) return null
  const left = minutesToCutoff(rules, clock)
  if (left === null || left <= 0 || left > rules.pickupReminderMinutes) return null
  return { minutesLeft: left }
}
