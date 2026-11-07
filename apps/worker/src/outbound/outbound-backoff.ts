import { OutboundLimits } from '@platform/core/domain'

import { SendAttemptFailed } from './send-refusal'

// The wait before the next attempt of an outbound job, doubling on each one. A failure waits from 5
// seconds; one the provider throttled waits from 15, because a throttle lasts minutes and five quick
// attempts would be spent before it lifts. Attempts are counted from 1 (the one that just failed).
export function outboundBackoff(attemptsMade: number, _type?: string, error?: Error): number {
  const base =
    error instanceof SendAttemptFailed && error.throttled
      ? OutboundLimits.THROTTLE_BACKOFF_MS
      : OutboundLimits.FAILURE_BACKOFF_MS
  return base * 2 ** (Math.max(attemptsMade, 1) - 1)
}
