import type { PinoLogger } from 'nestjs-pino'

import { type CredentialCipher, failureOf } from '@platform/core/crypto'
import { SealedOpenLog, type SealedValueKind } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

// The ids a log line names to find the row (never a value of it)
export interface SealedRef {
  organizationId?: string
  documentId?: string
  issuerId?: string
  customerId?: string
  contingencyId?: string
  batchId?: string
}

// The values already logged in this window (by what, the row and the cause): the oldest goes when the map is full. A Map keeps the order
// of insertion, so the first key is the oldest.
const loggedAt = new Map<string, number>()

// For the specs: forget what was logged
export function resetSealedOpenLog(): void {
  loggedAt.clear()
}

// True once per value, cause and window; false for a repeat inside it
function firstInWindow(key: string, now: number): boolean {
  const last = loggedAt.get(key)
  if (last !== undefined && now - last < SealedOpenLog.WINDOW_MS) return false
  loggedAt.delete(key)
  loggedAt.set(key, now)
  if (loggedAt.size > SealedOpenLog.MAX_REMEMBERED) {
    const oldest = loggedAt.keys().next().value
    if (oldest !== undefined) loggedAt.delete(oldest)
  }
  return true
}

// Opens a sealed value of the fiscal area or throws what the cipher threw. A value that does not open is logged with the name of the error,
// the cause as a code with no data (`failureOf`) and the ids of the row: never `error.message`, never the sealed bytes (a rotated key, a
// damaged row and a missing key look alike to a person, and tell an operator different things to do).
export function openSealed(
  cipher: CredentialCipher,
  logger: PinoLogger,
  sealed: Uint8Array,
  what: SealedValueKind,
  ref: SealedRef,
  // A read that only lists (a page of documents) fails quietly: the paths that act on the value (submit, evidence, contingency) log it
  quiet = false
): Record<string, unknown> {
  try {
    // The rotation window: a value not sealed again yet still opens (with the previous key, when the deployment holds one)
    return cipher.openRotating(sealed).credentials
  } catch (error) {
    const failure = failureOf(error)
    if (!quiet && firstInWindow(JSON.stringify([what, failure, ref]), Date.now())) {
      logger.error(
        { errorName: errorName(error), failure, what, ...ref },
        'a sealed fiscal value cannot be opened'
      )
    }
    throw error
  }
}
