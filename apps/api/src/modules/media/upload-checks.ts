import type { Redis } from 'ioredis'

import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { maxBytesFor, QUOTA_WINDOW_MS, refuseUpload, UploadRefusals } from '@platform/core/storage'

// The one answer for an upload that cannot be trusted: the object is missing, is not what was
// declared, or is not the one signed for this media. It says nothing about which of those.
export function uploadVerificationFailed(): PlatformException {
  return new PlatformException(
    ErrorCodes.FILE_UPLOAD_FAILED,
    'Upload verification failed',
    HttpStatusCodes.BAD_REQUEST
  )
}

export function refuseTypeOrSize(contentType: string, fileSizeBytes: number): void {
  const refused = refuseUpload(contentType, fileSizeBytes)
  if (refused === UploadRefusals.TYPE_NOT_ALLOWED) {
    throw new PlatformException(
      ErrorCodes.FILE_TYPE_NOT_ALLOWED,
      'File type not allowed',
      HttpStatusCodes.BAD_REQUEST,
      { contentType }
    )
  }
  if (refused === UploadRefusals.TOO_LARGE) {
    throw new PlatformException(
      ErrorCodes.FILE_TOO_LARGE,
      'File too large',
      HttpStatusCodes.BAD_REQUEST,
      { maxSizeBytes: maxBytesFor(contentType) }
    )
  }
}

// A counter outlives its window by one more, so it is never read half-expired
const QUOTA_TTL_SECONDS = (2 * QUOTA_WINDOW_MS) / 1000
// Count and expiry in one script, so a crash cannot leave a counter that never expires
const COUNT_SCRIPT = `
  local used = redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return used
`

// Counts one signed url against a counter of the hour and refuses the one past `limit`
export async function countWithinQuota(redis: Redis, key: string, limit: number): Promise<void> {
  const used = Number(await redis.eval(COUNT_SCRIPT, 1, key, QUOTA_TTL_SECONDS))
  if (used > limit) {
    throw new PlatformException(
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      'Too many upload urls requested',
      HttpStatusCodes.TOO_MANY_REQUESTS
    )
  }
}
