import { MediaPurpose } from './media-purpose'
import {
  AllAllowedContentTypes,
  AllowedContentTypes,
  AvatarUpload,
  UploadLimits
} from './upload-constants'

// The rules of what may be uploaded, apart from the schemas: the widget script on a store's site uses
// them and must not carry the validation library the schemas are built with.
export const UploadRefusals = {
  TYPE_NOT_ALLOWED: 'type_not_allowed',
  TOO_LARGE: 'too_large'
} as const
export type UploadRefusal = (typeof UploadRefusals)[keyof typeof UploadRefusals] | null

// The purposes whose rules are written here; a purpose a client may upload for must be one of them
// (upload-schemas.ts checks it at compile time), so a new one cannot get the message rules by default
export type UploadRulePurpose = typeof MediaPurpose.MESSAGE | typeof MediaPurpose.AVATAR

const isAvatar = (purpose: UploadRulePurpose): boolean => purpose === MediaPurpose.AVATAR

export function maxBytesFor(contentType: string, purpose: UploadRulePurpose): number {
  if (isAvatar(purpose)) return AvatarUpload.MAX_SIZE_BYTES
  return (AllowedContentTypes.VIDEO as readonly string[]).includes(contentType)
    ? UploadLimits.MAX_VIDEO_SIZE_BYTES
    : UploadLimits.MAX_FILE_SIZE_BYTES
}

// The one rule for what may be uploaded, used when the URL is signed and again when the upload is
// confirmed (the object in the bucket is not trusted because a client says it was checked). A purpose
// with rules of its own (an avatar: three image types, 2 MB) is held to them; any other is a message
// file. The purpose is required, so a caller cannot get the permissive rules by leaving it out.
export function refuseUpload(
  contentType: string,
  fileSizeBytes: number,
  purpose: UploadRulePurpose
): UploadRefusal {
  const allowed = isAvatar(purpose)
    ? (AvatarUpload.CONTENT_TYPES as readonly string[]).includes(contentType)
    : AllAllowedContentTypes.has(contentType)
  if (!allowed) return UploadRefusals.TYPE_NOT_ALLOWED
  return fileSizeBytes > maxBytesFor(contentType, purpose) ? UploadRefusals.TOO_LARGE : null
}
