import { z } from 'zod'

import { lowercasedUuidSchema } from '../validation'

import { MediaPurpose } from './media-purpose'
import type { UploadRulePurpose } from './upload-rules'

// The purposes a client may upload for. The others are written by the server (an export, a label) or
// need a parent that no step builds yet. Each of those steps adds its purpose here with its own checks,
// so that a purpose never exists in the API before the code that checks who may attach it. An avatar belongs to a user, not to a store, so it has its own routes
// (`ApiRoutes.account.avatarUploadUrl`, `avatarConfirm`; AvatarUploadsService) that need no store
// and no permission, and it is not a purpose of the store's routes: that would ask a Viewer for
// MEDIA_UPLOAD and use up the quota of the store.
// A product picture names its product in `parentId`; MediaService checks that it is one of the store
// and that the member may edit products, before any signed url or row. An order file (the proof of a
// delivery, the receipt of a payment) names its order the same way: one of the store, and a member who
// may edit it or change its status. The receipt of a transaction of the books names the transaction: one of the organization of the
// store, and a member who may register that kind of transaction.
export const ClientUploadPurposes = [
  MediaPurpose.MESSAGE,
  MediaPurpose.PRODUCT,
  MediaPurpose.ORDER,
  MediaPurpose.FINANCE_DOCUMENT
] as const
export type ClientUploadPurpose = (typeof ClientUploadPurposes)[number]
// Does not compile when a purpose is added above without rules in upload-rules.ts
export const UPLOAD_PURPOSES_HAVE_RULES: readonly UploadRulePurpose[] = ClientUploadPurposes

const FILENAME_TRICKS = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u
// A name with a control, line-break or direction-changing character is a mistake or a trick ("a\u202Eexe.pdf"): refused here, and the key and the header
// are made from the sanitized name anyway
export const uploadFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(value => !FILENAME_TRICKS.test(value), {
    message: 'a file name has no control, line-break or direction-override character'
  })
const contentTypeSchema = z.string().min(1).max(127)
const fileSizeSchema = z.number().int().positive()

// What a file of each purpose says about itself. A product picture and an order file name their parent; a message file has
// none, and a `parentId` on it is refused like any field the schema does not know (the shapes are strict).
const fileFields = {
  filename: uploadFilenameSchema,
  contentType: contentTypeSchema,
  fileSizeBytes: fileSizeSchema
}
const messageFields = { purpose: z.literal(MediaPurpose.MESSAGE) }
const productFields = { purpose: z.literal(MediaPurpose.PRODUCT), parentId: lowercasedUuidSchema }
const orderFields = { purpose: z.literal(MediaPurpose.ORDER), parentId: lowercasedUuidSchema }
const financeDocumentFields = {
  purpose: z.literal(MediaPurpose.FINANCE_DOCUMENT),
  parentId: lowercasedUuidSchema
}
const confirmFields = { mediaId: lowercasedUuidSchema, key: z.string().min(1).max(1024) }

// Whether the type is allowed and the size fits is NOT checked here: the answers are the error codes
// FILE_TYPE_NOT_ALLOWED and FILE_TOO_LARGE, which a client tells apart from a malformed body.
export const requestUploadUrlSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ ...messageFields, ...fileFields }),
  z.strictObject({ ...productFields, ...fileFields }),
  z.strictObject({ ...orderFields, ...fileFields }),
  z.strictObject({ ...financeDocumentFields, ...fileFields })
])
export type RequestUploadUrlBody = z.infer<typeof requestUploadUrlSchema>

export const confirmUploadSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ ...confirmFields, ...messageFields, ...fileFields }),
  z.strictObject({ ...confirmFields, ...productFields, ...fileFields }),
  z.strictObject({ ...confirmFields, ...orderFields, ...fileFields }),
  z.strictObject({ ...confirmFields, ...financeDocumentFields, ...fileFields })
])
export type ConfirmUploadBody = z.infer<typeof confirmUploadSchema>

export interface UploadUrlResult {
  uploadUrl: string
  key: string
  mediaId: string
}
