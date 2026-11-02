import { z } from 'zod'

import { MediaPurpose } from './media-purpose'
import type { UploadRulePurpose } from './upload-rules'

// The purposes a client may upload for. The others are written by the server (an export, a label) or
// need a parent that no step builds yet: product and order media come with Steps 4.x. Each of those
// steps adds its purpose here with its own checks, so that a purpose never exists in the API before
// the code that checks who may attach it. An avatar belongs to a user, not to a store, so it has its own
// routes (`ApiRoutes.account.avatarUploadUrl`, `avatarConfirm`; AvatarUploadsService) that need no store
// and no permission, and it is not a purpose of the store's routes: that would ask a Viewer for
// MEDIA_UPLOAD and use up the quota of the store.
export const ClientUploadPurposes = [MediaPurpose.MESSAGE] as const
export type ClientUploadPurpose = (typeof ClientUploadPurposes)[number]
// Does not compile when a purpose is added above without rules in upload-rules.ts
export const UPLOAD_PURPOSES_HAVE_RULES: readonly UploadRulePurpose[] = ClientUploadPurposes

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

// The avatar of the person who asks: the purpose is the route's, so the body does not carry one
export const requestAvatarUploadSchema = z.strictObject({
  filename: filenameSchema,
  contentType: contentTypeSchema,
  fileSizeBytes: fileSizeSchema
})
export type RequestAvatarUploadBody = z.infer<typeof requestAvatarUploadSchema>

export const confirmAvatarUploadSchema = z.strictObject({
  mediaId: z.uuid(),
  key: z.string().min(1).max(1024),
  filename: filenameSchema,
  contentType: contentTypeSchema,
  fileSizeBytes: fileSizeSchema
})
export type ConfirmAvatarUploadBody = z.infer<typeof confirmAvatarUploadSchema>
