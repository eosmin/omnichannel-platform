import { z } from 'zod'

const filenameSchema = z.string().min(1).max(255)
const contentTypeSchema = z.string().min(1).max(127)
const fileSizeSchema = z.number().int().positive()

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
