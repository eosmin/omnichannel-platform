import type { PinoLogger } from 'nestjs-pino'

import { type CredentialCipher, failureOf } from '@platform/core/crypto'
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
  what: string,
  ref: SealedRef
): Record<string, unknown> {
  try {
    return cipher.open(sealed)
  } catch (error) {
    logger.error(
      { errorName: errorName(error), failure: failureOf(error), what, ...ref },
      'a sealed fiscal value cannot be opened'
    )
    throw error
  }
}
