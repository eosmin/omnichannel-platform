import { InboundLimits } from '@platform/core/domain'

// When a message happened, as far as the platform believes it. A provider dates its messages, but a
// date that is ahead of the clock is a wrong clock or a lie: it would pin the conversation to the top
// of the inbox, so it counts as now. So does a date from long ago, which is a wrong unit, and a date
// that cannot be read.
export function receivedTime(timestamp: string, now: Date): Date {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return now
  const tooFarAhead = at.getTime() > now.getTime() + InboundLimits.MAX_FUTURE_SKEW_MS
  const tooOld = at.getTime() < now.getTime() - InboundLimits.MAX_AGE_MS
  return tooFarAhead || tooOld ? now : at
}
