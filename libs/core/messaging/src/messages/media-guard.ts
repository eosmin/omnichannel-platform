import { isCleanableType } from '@platform/core/av-sanitizer'
import { MediaStatus } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { AvSanitizing, ExistingPictureSweep } from '@platform/core/storage'

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

// A video or audio file the scan could not clean of its metadata is kept as it came and still ends `clean` (the scan goes on, nothing is
// refused: `MediaPipeline.sanitizeAvFile`), with its reason in `scanResult` (`AvSanitizing.OUTCOME_KEY`). It may be shown to the agent who
// uploaded it, never sent: its location, camera and time would leave with it.
export function isKeptWithMetadata(scanResult: unknown): boolean {
  return (
    typeof scanResult === 'object' &&
    scanResult !== null &&
    !Array.isArray(scanResult) &&
    AvSanitizing.OUTCOME_KEY in scanResult
  )
}

// Whether the bytes of a clean file may leave the platform. A video or an audio file must carry the mark of the cleaning (`sanitized: true`,
// written only with the copy that has no metadata): a row with no mark (uploaded before the cleaning existed, or one a sweep has not reached)
// is as unsafe as one kept as it came, so the rule is an allow-list. Any other file has nothing to wait for here.
export function isReadyToSend(row: { contentType: string; scanResult: unknown }): boolean {
  if (isKeptWithMetadata(row.scanResult)) return false
  if (!isCleanableType(row.contentType)) return true
  const mark: unknown =
    typeof row.scanResult === 'object' && row.scanResult !== null
      ? (row.scanResult as Record<string, unknown>)[ExistingPictureSweep.CLEANED_KEY]
      : undefined
  return mark === true
}

// What may leave the platform to a customer: servable (clean) and ready to send. The same answer as a file the channel found missing
// (`FILE_UNAVAILABLE`), until the sweep of stored files cleans it (Step 7.1-J-3).
export function assertMediaSendable(row: {
  status: string
  contentType: string
  scanResult: unknown
}): void {
  assertMediaServable(row.status)
  if (!isReadyToSend(row)) {
    throw new PlatformException(
      ErrorCodes.FILE_UNAVAILABLE,
      'File could not be prepared for sending',
      HttpStatusCodes.CONFLICT
    )
  }
}
