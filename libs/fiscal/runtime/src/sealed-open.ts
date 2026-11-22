import type { PinoLogger } from 'nestjs-pino'

import { type CredentialCipher, failureOf } from '@platform/core/crypto'
import type { SealedValueKind } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

// The ids a log line names to find the row (never a value of it)
export interface SealedRef {
  organizationId?: string
  documentId?: string
  issuerId?: string
  customerId?: string
  contingencyId?: string
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
    if (!quiet) {
      logger.error(
        { errorName: errorName(error), failure: failureOf(error), what, ...ref },
        'a sealed fiscal value cannot be opened'
      )
    }
    throw error
  }
}
