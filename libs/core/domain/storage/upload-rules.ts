import { AllAllowedContentTypes, AllowedContentTypes, UploadLimits } from './upload-constants'

// The rules of what may be uploaded, apart from the schemas: the widget script on a store's site uses
// them and must not carry the validation library the schemas are built with.
export const UploadRefusals = {
  TYPE_NOT_ALLOWED: 'type_not_allowed',
  TOO_LARGE: 'too_large'
} as const
export type UploadRefusal = (typeof UploadRefusals)[keyof typeof UploadRefusals] | null

export function maxBytesFor(contentType: string): number {
  return (AllowedContentTypes.VIDEO as readonly string[]).includes(contentType)
    ? UploadLimits.MAX_VIDEO_SIZE_BYTES
    : UploadLimits.MAX_FILE_SIZE_BYTES
}

// The one rule for what may be uploaded, used when the URL is signed and again when the upload is
// confirmed (the object in the bucket is not trusted because a client says it was checked).
export function refuseUpload(contentType: string, fileSizeBytes: number): UploadRefusal {
  if (!AllAllowedContentTypes.has(contentType)) return UploadRefusals.TYPE_NOT_ALLOWED
  return fileSizeBytes > maxBytesFor(contentType) ? UploadRefusals.TOO_LARGE : null
}
