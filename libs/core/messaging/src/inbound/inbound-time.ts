import { InboundLimits } from '@platform/core/domain'

// When a message happened, as far as the platform believes it: the date the provider gave, never later
// than the moment the platform received it (min(timestamp, now)). A date that is ahead of the clock is a
// wrong clock or a lie: it would pin the conversation to the top of the inbox and set its last inbound
// time in the future, so it counts as now, however small the drift. So does a date from long ago, which
// is a wrong unit, and a date that cannot be read.
export function receivedTime(timestamp: string, now: Date): Date {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return now
  const ahead = at.getTime() > now.getTime()
  const tooOld = at.getTime() < now.getTime() - InboundLimits.MAX_AGE_MS
  return ahead || tooOld ? now : at
}
