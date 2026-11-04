import type { Redis } from 'ioredis'

import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import {
  FILE_SIGNATURE_WINDOW_BYTES,
  matchesDeclaredType,
  maxBytesFor,
  QUOTA_WINDOW_MS,
  refuseUpload,
  type UploadRulePurpose,
  UploadRefusals
} from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

// The one answer for an upload that cannot be trusted: the object is missing, is not what was
// declared, or is not the one signed for this media. It says nothing about which of those.
export function uploadVerificationFailed(): PlatformException {
  return new PlatformException(
    ErrorCodes.FILE_UPLOAD_FAILED,
    'Upload verification failed',
    HttpStatusCodes.BAD_REQUEST
  )
}

export function refuseTypeOrSize(
  contentType: string,
  fileSizeBytes: number,
  purpose: UploadRulePurpose
): void {
  const refused = refuseUpload(contentType, fileSizeBytes, purpose)
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
      { maxSizeBytes: maxBytesFor(contentType, purpose) }
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

// The declared type is the client's word. The first bytes of the object, read pinned to the ETag that
// was checked (a file put there since gives nothing), must be those of that type: an HTML page named
// `fake.png` is refused here instead of being kept, scanned clean and served as a picture.
export async function refuseSignatureMismatch(
  storage: StorageService,
  key: string,
  contentType: string,
  etag: string | undefined
): Promise<void> {
  // Without an ETag the read and the copy could not be pinned to the bytes that were checked
  if (etag === undefined) throw uploadVerificationFailed()
  const head = await storage.readStart(key, FILE_SIGNATURE_WINDOW_BYTES, etag)
  if (head === null) throw uploadVerificationFailed()
  if (!matchesDeclaredType(contentType, head)) {
    throw new PlatformException(
      ErrorCodes.FILE_TYPE_NOT_ALLOWED,
      'File type not allowed',
      HttpStatusCodes.BAD_REQUEST,
      { contentType }
    )
  }
}
