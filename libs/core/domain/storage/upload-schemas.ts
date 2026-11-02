import { z } from 'zod'

import { MediaPurpose } from './media-purpose'

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
