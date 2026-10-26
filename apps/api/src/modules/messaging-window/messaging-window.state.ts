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

// A window opens when the customer writes and lasts `hours`; it is closed at the very moment it ends
export function stateOf(
  policy: MessagingWindowPolicy | null,
  lastInboundAt: Date | null,
  now: Date
): MessagingWindowState {
  if (policy === null) return { open: true, closesAt: null, requiresTemplate: false }
  // A message cannot come from the future: a clock that runs ahead does not make the window longer
  const closesAt =
    lastInboundAt === null
      ? null
      : new Date(Math.min(lastInboundAt.getTime(), now.getTime()) + policy.hours * HOUR_MS)
  const open = closesAt !== null && now.getTime() < closesAt.getTime()
  return { open, closesAt, requiresTemplate: !open && policy.requiresTemplateWhenClosed }
}
