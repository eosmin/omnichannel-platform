import { ErrorCodes } from './error-codes'
import { HttpStatusCodes } from './http-status-codes'
import { PlatformException } from './platform-exception'

// The answers that almost every service gives, built in one place. The message is English and goes
// to the logs; the client reads the code. Writing `new PlatformException(ErrorCodes.RESOURCE_...)` by
// hand elsewhere is refused by eslint; these are the exceptions.

// `what` names the resource ("customer").
export function resourceNotFound(what: string): PlatformException {
  return new PlatformException(
    // eslint-disable-next-line no-restricted-syntax -- the one place that builds this answer
    ErrorCodes.RESOURCE_NOT_FOUND,
    `${what} not found`,
    HttpStatusCodes.NOT_FOUND
  )
}

// The state of the resource does not allow what was asked. `metadata` tells the client what to do
// about it (whose handle it is, which tables hold data).
export function resourceConflict(
  message: string,
  metadata?: Record<string, unknown>
): PlatformException {
  return new PlatformException(
    // eslint-disable-next-line no-restricted-syntax -- the one place that builds this answer
    ErrorCodes.RESOURCE_CONFLICT,
    message,
    HttpStatusCodes.CONFLICT,
    metadata
  )
}

// The caller is not authenticated: no token, a signature that does not verify, an account that is
// gone. (A token that expired or is invalid has its own codes.)
export function unauthorized(
  message: string,
  metadata?: Record<string, unknown>
): PlatformException {
  return new PlatformException(
    // eslint-disable-next-line no-restricted-syntax -- the one place that builds this answer
    ErrorCodes.AUTH_UNAUTHORIZED,
    message,
    HttpStatusCodes.UNAUTHORIZED,
    metadata
  )
}
