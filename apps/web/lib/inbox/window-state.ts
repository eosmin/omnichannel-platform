import type { MessagingWindowView } from '@platform/api-client'

// With less than this left the composer says so: a reply that takes longer would not go out
const WINDOW_WARNING_MS = 2 * 60 * 60_000

export type WindowState =
  | { kind: 'open' }
  | { kind: 'closing'; remainingMs: number }
  // Free text cannot go. `requiresTemplate` says whether a template can: Instagram and Messenger let
  // nothing through once the window is over
  | { kind: 'closed'; requiresTemplate: boolean }

// What the composer shows. Whether the window is open is the server's word; only how long is left is
// counted here. A window that ends while the page is open stays "closing" with nothing left until the
// answer is read again (use-messaging-window does it at that moment), because only the server knows
// whether a template can follow. Until the first answer nothing is blocked: the api checks the send.
export function windowStateOf(view: MessagingWindowView | undefined, now: Date): WindowState {
  if (view === undefined) return { kind: 'open' }
  if (!view.open) return { kind: 'closed', requiresTemplate: view.requiresTemplate }
  if (view.closesAt === null) return { kind: 'open' }
  const remainingMs = Math.max(0, Date.parse(view.closesAt) - now.getTime())
  return remainingMs < WINDOW_WARNING_MS ? { kind: 'closing', remainingMs } : { kind: 'open' }
}

// The time left, for a sentence: whole hours and the minutes that remain, rounded up so that the
// banner never says "0m" while there is still some time
export function hoursAndMinutes(ms: number): { hours: number; minutes: number } {
  const totalMinutes = Math.ceil(ms / 60_000)
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 }
}
