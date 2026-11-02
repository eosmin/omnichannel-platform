import { MediaStatus } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

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
