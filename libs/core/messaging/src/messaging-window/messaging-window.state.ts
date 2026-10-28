import type { MessagingWindowPolicy } from '@platform/core/domain'

const HOUR_MS = 60 * 60 * 1000

// Whether the store may answer a customer with free text now. `closesAt` is the moment the window
// ends (null when the channel has no window, or when the customer never wrote and there is none to
// count from), so the composer can say how long is left.
export interface MessagingWindowState {
  open: boolean
  closesAt: Date | null
  requiresTemplate: boolean
}

// When a window that opened at `from` ends. A message cannot come from the future: a clock that runs
// ahead does not make the window longer.
const endOf = (from: Date, hours: number, now: Date): number =>
  Math.min(from.getTime(), now.getTime()) + hours * HOUR_MS

// A window opens when the customer writes and lasts `hours`; after a click on an ad, a channel that
// has `extendedHoursAfterAd` lets it last that long from the first message, and the later end wins.
// It is closed at the very moment it ends.
export function stateOf(
  policy: MessagingWindowPolicy | null,
  lastInboundAt: Date | null,
  now: Date,
  adWindowOpenedAt: Date | null = null
): MessagingWindowState {
  if (policy === null) return { open: true, closesAt: null, requiresTemplate: false }
  const ends = [
    ...(lastInboundAt === null ? [] : [endOf(lastInboundAt, policy.hours, now)]),
    ...(adWindowOpenedAt === null || policy.extendedHoursAfterAd === undefined
      ? []
      : [endOf(adWindowOpenedAt, policy.extendedHoursAfterAd, now)])
  ]
  const closesAt = ends.length === 0 ? null : new Date(Math.max(...ends))
  const open = closesAt !== null && now.getTime() < closesAt.getTime()
  return { open, closesAt, requiresTemplate: !open && policy.requiresTemplateWhenClosed }
}
