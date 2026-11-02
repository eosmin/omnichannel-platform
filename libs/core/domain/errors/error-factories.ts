import { MediaStatus } from '../status-enums'

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

// A file may be served or attached only once it is clean. Infected is refused for good (403), a file
// the scan gave up on is gone (410), and one still being scanned is a conflict the caller may retry.
export function assertMediaServable(status: string): void {
  if (status === String(MediaStatus.CLEAN)) return
  if (status === String(MediaStatus.INFECTED)) {
    throw new PlatformException(
      ErrorCodes.FILE_INFECTED,
      'File unavailable',
      HttpStatusCodes.FORBIDDEN
    )
  }
  if (status === String(MediaStatus.UNSCANNABLE)) {
    throw new PlatformException(
      ErrorCodes.FILE_UNSCANNABLE,
      'File could not be scanned',
      HttpStatusCodes.GONE
    )
  }
  throw new PlatformException(
    ErrorCodes.FILE_NOT_READY,
    'File is being scanned',
    HttpStatusCodes.CONFLICT
  )
}
