import { WebPushError } from 'web-push'

import { HttpStatusCodes } from '@platform/core/errors'
import { type PushOutcome, PushLimits, PushOutcomes } from '@platform/core/notifications'

// The outcome of a push that threw, for the counter and the alert. `gone` and `transient` are what the sender already decided.
export function refusalOutcomeOf(error: unknown): PushOutcome {
  if (!(error instanceof WebPushError)) return PushOutcomes.REFUSED_OTHER
  switch (error.statusCode) {
    case HttpStatusCodes.BAD_REQUEST:
      return PushOutcomes.REFUSED_BAD_REQUEST
    case HttpStatusCodes.UNAUTHORIZED:
    case HttpStatusCodes.FORBIDDEN:
      return PushOutcomes.REFUSED_AUTH
    case HttpStatusCodes.PAYLOAD_TOO_LARGE:
      return PushOutcomes.REFUSED_TOO_LARGE
    default:
      return PushOutcomes.REFUSED_OTHER
  }
}

// The last pushes this process tried and how each ended. A 400 normally names one browser's own subscription; when most of what the
// process sends is a 400, the fault is the server's, and counting it against browsers would empty their lists (see PushLimits.SYSTEMIC_*).
// Kept in memory and per process: a restart starts empty, and an empty window is "not systemic", which is the old behavior.
export class PushOutcomeWindow {
  private readonly outcomes: PushOutcome[] = []

  record(outcome: PushOutcome): void {
    this.outcomes.push(outcome)
    if (this.outcomes.length > PushLimits.SYSTEMIC_WINDOW) this.outcomes.shift()
  }

  isSystemicBadRequest(): boolean {
    if (this.outcomes.length < PushLimits.SYSTEMIC_MIN_SAMPLE) return false
    const bad = this.outcomes.filter(o => o === PushOutcomes.REFUSED_BAD_REQUEST).length
    return bad / this.outcomes.length >= PushLimits.SYSTEMIC_BAD_REQUEST_SHARE
  }
}
