import { MediaPurpose } from './media-purpose'
import {
  AllAllowedContentTypes,
  AllowedContentTypes,
  AvatarUpload,
  OrderFileUpload,
  ProductImageUpload,
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
export type UploadRulePurpose =
  | typeof MediaPurpose.MESSAGE
  | typeof MediaPurpose.AVATAR
  | typeof MediaPurpose.PRODUCT
  | typeof MediaPurpose.ORDER

// The purposes with rules of their own: a few still image types and a smaller limit. Any other is a
// message file.
interface ImageRules {
  readonly CONTENT_TYPES: readonly string[]
  readonly MAX_SIZE_BYTES: number
}
function imageRulesOf(purpose: UploadRulePurpose): ImageRules | null {
  if (purpose === MediaPurpose.AVATAR) return AvatarUpload
  if (purpose === MediaPurpose.PRODUCT) return ProductImageUpload
  if (purpose === MediaPurpose.ORDER) return OrderFileUpload
  return null
}

export function maxBytesFor(contentType: string, purpose: UploadRulePurpose): number {
  const rules = imageRulesOf(purpose)
  if (rules !== null) return rules.MAX_SIZE_BYTES
  return (AllowedContentTypes.VIDEO as readonly string[]).includes(contentType)
    ? UploadLimits.MAX_VIDEO_SIZE_BYTES
    : UploadLimits.MAX_FILE_SIZE_BYTES
}

// The one rule for what may be uploaded, used when the URL is signed and again when the upload is
// confirmed (the object in the bucket is not trusted because a client says it was checked). A purpose
// with rules of its own (an avatar: three image types, 2 MB; a product picture: the same types, 5 MB; an order file: those and a PDF, 10 MB) is held to them; any other is a message
// file. The purpose is required, so a caller cannot get the permissive rules by leaving it out.
export function refuseUpload(
  contentType: string,
  fileSizeBytes: number,
  purpose: UploadRulePurpose
): UploadRefusal {
  const rules = imageRulesOf(purpose)
  const allowed =
    rules !== null
      ? rules.CONTENT_TYPES.includes(contentType)
      : AllAllowedContentTypes.has(contentType)
  if (!allowed) return UploadRefusals.TYPE_NOT_ALLOWED
  return fileSizeBytes > maxBytesFor(contentType, purpose) ? UploadRefusals.TOO_LARGE : null
}
