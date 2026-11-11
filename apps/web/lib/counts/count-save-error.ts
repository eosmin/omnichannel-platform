import { ApiError } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

// Whether sending the quantities again later may work. No signal, a server that is down or busy: yes, the quantities wait
// in the draft. A refusal of the api about the request itself (the count is no longer being counted, the line is not
// the person's, the permission is gone): no, sending the same thing again gets the same answer.
export function isRetryableSaveError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return (
    error.status >= HttpStatusCodes.INTERNAL_SERVER_ERROR ||
    error.status === HttpStatusCodes.TOO_MANY_REQUESTS ||
    error.status === HttpStatusCodes.REQUEST_TIMEOUT ||
    // The api cannot be reached: the client made up an error with no status of its own
    error.status === 0
  )
}
