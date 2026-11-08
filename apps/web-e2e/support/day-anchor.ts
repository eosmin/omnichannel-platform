import { setUserTimezone } from './database'

// Where the messages and files of a case are put in time, so that the days the page draws between them do not
// depend on the hour the suite runs. A case that seeds "the last hour" with `Date.now()` has, once a day, a window
// that crosses midnight: the page then draws a separator more, and the case that counts or scrolls to a day
// fails at that hour only. Two rules, both about the day of the zone the page uses:
//   - the zone is fixed: the person of the case is put in UTC (`pinAccountToUtc`), because the page writes in the
//     zone of the account, and the machine that runs the browser can be in any other;
//   - "now" is read once, and a window that would cross midnight is moved to the day before, at noon.
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MARGIN_MS = 5 * 60_000

const startOfUtcDay = (at: number): number => at - (at % DAY_MS)

// The instant that ends a window of `spanMs` and lies in one UTC day with all of it. It is now, unless the window
// would start the day before (or too close to its start): then it is noon of the day before, far from both
// midnights. The messages of the case are `anchor - something`, never `Date.now() - something` again.
export function seedAnchor(spanMs: number, now: number = Date.now()): number {
  // Noon of the day before is the fallback: a longer window would cross midnight there too
  if (spanMs > 11 * HOUR_MS)
    throw new Error('seedAnchor: a window of more than 11 hours cannot avoid midnight')
  const sinceMidnight = now - startOfUtcDay(now)
  return sinceMidnight >= spanMs + MARGIN_MS ? now : startOfUtcDay(now) - DAY_MS + 12 * HOUR_MS
}

// Noon of the UTC day `daysAgo` days before the one of `now`: for a case that wants a message on each of several days
export function noonUtcDaysAgo(daysAgo: number, now: number = Date.now()): number {
  return startOfUtcDay(now) - daysAgo * DAY_MS + 12 * HOUR_MS
}

// The zone of the person is UTC for the case, and what it was comes back at the end (even if the case fails).
// Other cases read the same person.
export async function pinAccountToUtc(email: string): Promise<() => Promise<void>> {
  const before = await setUserTimezone(email, 'UTC')
  return async () => {
    await setUserTimezone(email, before)
  }
}
