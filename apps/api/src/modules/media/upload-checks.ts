import type { Redis } from 'ioredis'

import { type Permission, Permissions, RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import {
  type ClientUploadPurpose,
  FILE_SIGNATURE_WINDOW_BYTES,
  MediaPurpose,
  type MediaPurposeType,
  matchesDeclaredType,
  maxBytesFor,
  QUOTA_WINDOW_MS,
  refuseUpload,
  type UploadRulePurpose,
  UploadRefusals
} from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

// What a member must hold, besides MEDIA_UPLOAD (the route's), to upload a file for a purpose: every
// permission of `all`, and one of `any` when it is not empty. Attaching a picture to a product changes the
// product, so it asks for what editing it asks for. A file of an order (a proof of delivery, a receipt) is
// attached by who may see the order and edits it or moves its status: asking for ORDERS_VIEW too means the
// answer for an order id never tells more than reading the order would. A purpose of a client is in this
// table (it does not compile without), so none is added without saying who may use it.
interface UploadRule {
  readonly all: readonly Permission[]
  readonly any: readonly Permission[]
}
const PURPOSE_PERMISSIONS: Record<ClientUploadPurpose, UploadRule> = {
  [MediaPurpose.MESSAGE]: { all: [], any: [] },
  [MediaPurpose.PRODUCT]: { all: [Permissions.PRODUCTS_EDIT], any: [] },
  [MediaPurpose.ORDER]: {
    all: [Permissions.ORDERS_VIEW],
    any: [Permissions.ORDERS_EDIT, Permissions.ORDERS_CHANGE_STATUS]
  }
}

export function refuseUnlessMayUpload(
  purpose: ClientUploadPurpose,
  held: readonly Permission[]
): void {
  const { all, any } = PURPOSE_PERMISSIONS[purpose]
  const missing = all.filter(permission => !held.includes(permission))
  const anyMet = any.length === 0 || any.some(permission => held.includes(permission))
  if (missing.length === 0 && anyMet) return
  throw new PlatformException(
    ErrorCodes.PERMISSION_DENIED,
    'Missing permission for this kind of file',
    HttpStatusCodes.FORBIDDEN,
    { required: [...missing, ...(anyMet ? [] : any)] }
  )
}

// What a reader must hold, besides MEDIA_VIEW (the route's), to be given the signed link of a file of a
// purpose: the proof of a delivery or the receipt of a payment is customer data of an order, so it asks
// for what viewing orders asks for. Every purpose is listed (it does not compile without), so a purpose
// that starts to be stored as media cannot be served by default: null says "the route's permission alone".
// `held` null is a reader that is not a member (a widget visitor): it only gets a purpose with null.
const READ_PERMISSIONS: Record<MediaPurposeType, Permission | null> = {
  [MediaPurpose.MESSAGE]: null,
  [MediaPurpose.ORIGIN]: null,
  [MediaPurpose.PRODUCT]: null,
  [MediaPurpose.ORDER]: Permissions.ORDERS_VIEW,
  [MediaPurpose.AVATAR]: null,
  [MediaPurpose.EXPORT]: null,
  [MediaPurpose.SHIPPING_LABEL]: null,
  [MediaPurpose.BULK_LABELS]: null,
  [MediaPurpose.REMITTANCE_FILE]: null
}

export function refuseUnlessMayRead(purpose: string, held: readonly Permission[] | null): void {
  // A value the table does not know is refused, never served
  const known = Object.hasOwn(READ_PERMISSIONS, purpose)
  const needed = known ? READ_PERMISSIONS[purpose as MediaPurposeType] : undefined
  if (needed === null) return
  if (needed !== undefined && held !== null && held.includes(needed)) return
  throw new PlatformException(
    ErrorCodes.PERMISSION_DENIED,
    'Missing permission for this kind of file',
    HttpStatusCodes.FORBIDDEN,
    { required: needed === undefined ? [] : [needed] }
  )
}

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

// Counts one signed url against the counter of an hour and refuses the one past `limit`, saying how
// many seconds are left of that hour, as every other refusal of a limit does. `bucket` is the hour the
// key was built with (`Math.floor(Date.now() / QUOTA_WINDOW_MS)`), so the time left is the one of the
// counter that refused, even when the clock crossed the hour between building the key and counting.
export async function countWithinQuota(
  redis: Redis,
  key: string,
  limit: number,
  bucket: number
): Promise<void> {
  const used = Number(await redis.eval(COUNT_SCRIPT, 1, key, QUOTA_TTL_SECONDS))
  if (used > limit) {
    const msLeft = Math.max((bucket + 1) * QUOTA_WINDOW_MS - Date.now(), 1000)
    throw new PlatformException(
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      'Too many upload urls requested',
      HttpStatusCodes.TOO_MANY_REQUESTS,
      { [RETRY_AFTER_METADATA_KEY]: Math.ceil(msLeft / 1000) }
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
