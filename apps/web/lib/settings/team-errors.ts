import { ApiError } from '@platform/api-client'
import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { ClientErrorCodes } from '@platform/core/errors'

// How long a refused resend must wait, when the api says so: the cooldown of inviting answers 429 with
// the wait in its metadata. Null for any other error, and for an answer with no usable number.
export function retryAfterSecondsOf(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== ClientErrorCodes.RATE_LIMIT_EXCEEDED)
    return null
  const seconds = error.metadata[RETRY_AFTER_METADATA_KEY]
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : null
}
