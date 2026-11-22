import { z } from 'zod'

import { lowercasedUuidSchema } from '@platform/core/domain'
import { uploadFilenameSchema } from '@platform/core/storage'

const contentTypeSchema = z.string().min(1).max(127)
const fileSizeSchema = z.number().int().positive()

// The avatar of the person who asks: the purpose is the route's, so the body does not carry one
export const requestAvatarUploadSchema = z.strictObject({
  filename: uploadFilenameSchema,
  contentType: contentTypeSchema,
  fileSizeBytes: fileSizeSchema
})
export type RequestAvatarUploadBody = z.infer<typeof requestAvatarUploadSchema>

export const confirmAvatarUploadSchema = z.strictObject({
  mediaId: lowercasedUuidSchema,
  key: z.string().min(1).max(1024),
  filename: uploadFilenameSchema,
  contentType: contentTypeSchema,
  fileSizeBytes: fileSizeSchema
})
export type ConfirmAvatarUploadBody = z.infer<typeof confirmAvatarUploadSchema>
