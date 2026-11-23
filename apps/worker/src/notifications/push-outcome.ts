import { WebPushError } from 'web-push'

import { HttpStatusCodes } from '@platform/core/errors'
import { type PushOutcome, PushLimits, PushOutcomes } from '@platform/core/notifications'

// The outcome of a push that threw, for the counter and the alert. `gone` and `transient` are what the sender already decided.
export function refusalOutcomeOf(error: unknown): PushOutcome {
  if (!(error instanceof WebPushError)) return PushOutcomes.REFUSED_LOCAL
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

// The last pushes this process tried and how each ended. A 400 names one browser's own subscription only when the server is known to be
// sound; a process that delivered nothing lately cannot tell a bad browser from a bad payload (see PushLimits.SOUND_WINDOW).
// Kept in memory and per process: a restart starts empty, and an empty window counts nothing, which fails safe (nothing is dropped).
export class PushOutcomeWindow {
  private readonly outcomes: PushOutcome[] = []

  record(outcome: PushOutcome): void {
    this.outcomes.push(outcome)
    if (this.outcomes.length > PushLimits.SOUND_WINDOW) this.outcomes.shift()
  }

  serverLooksSound(): boolean {
    return this.outcomes.includes(PushOutcomes.DELIVERED)
  }
}
