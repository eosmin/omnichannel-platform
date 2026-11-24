import { z } from 'zod'

import {
  type ApiClient,
  type UploadFileInfo,
  uploadUrlSchema,
  type UploadUrlView
} from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// The picture of the person: three steps like a file of a message, on routes that need no store
// (and so no permission: a Viewer has a picture too). Attaching it is `updateOwnProfile`.
const confirmedAvatarSchema = z.object({ mediaId: z.string(), status: z.string() })
export type ConfirmedAvatar = z.output<typeof confirmedAvatarSchema>

export function requestAvatarUploadUrl(
  client: ApiClient,
  file: UploadFileInfo
): Promise<UploadUrlView> {
  return client.request(ApiRoutes.account.avatarUploadUrl, {
    method: 'POST',
    body: file,
    schema: uploadUrlSchema
  })
}

export function confirmAvatarUpload(
  client: ApiClient,
  input: UploadFileInfo & { mediaId: string; key: string }
): Promise<ConfirmedAvatar> {
  return client.request(ApiRoutes.account.avatarConfirm, {
    method: 'POST',
    body: input,
    schema: confirmedAvatarSchema
  })
}
