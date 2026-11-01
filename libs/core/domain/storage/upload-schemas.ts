import { z } from 'zod'

import { MediaPurpose } from './media-purpose'
import { AllAllowedContentTypes, AllowedContentTypes, UploadLimits } from './upload-constants'

// The purposes a client may upload for. The others are written by the server (an export, a label) or
// need a parent that no step builds yet: product and order media come with Steps 4.x, an avatar with
// Step 3.6. Each of those steps adds its purpose here with its own checks, so that a purpose never
// exists in the API before the code that checks who may attach it.
export const ClientUploadPurposes = [MediaPurpose.MESSAGE] as const
export type ClientUploadPurpose = (typeof ClientUploadPurposes)[number]

const filenameSchema = z.string().min(1).max(255)
const contentTypeSchema = z.string().min(1).max(127)
const fileSizeSchema = z.number().int().positive()

// Whether the type is allowed and the size fits is NOT checked here: the answers are the error codes
// FILE_TYPE_NOT_ALLOWED and FILE_TOO_LARGE, which a client tells apart from a malformed body.
export const requestUploadUrlSchema = z.strictObject({
  purpose: z.enum(ClientUploadPurposes),
  filename: filenameSchema,
  contentType: contentTypeSchema,
  fileSizeBytes: fileSizeSchema
})
export type RequestUploadUrlBody = z.infer<typeof requestUploadUrlSchema>

export const confirmUploadSchema = z.strictObject({
  mediaId: z.uuid(),
  key: z.string().min(1).max(1024),
  purpose: z.enum(ClientUploadPurposes),
  filename: filenameSchema,
  contentType: contentTypeSchema,
  fileSizeBytes: fileSizeSchema
})
export type ConfirmUploadBody = z.infer<typeof confirmUploadSchema>

export interface UploadUrlResult {
  uploadUrl: string
  key: string
  mediaId: string
}

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
