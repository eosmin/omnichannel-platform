import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { ImageVariants, MediaPurpose } from '@platform/core/storage'

import type { ApiClient } from './api-client'

const uploadUrlSchema = z.object({
  uploadUrl: z.url(),
  key: z.string(),
  mediaId: z.string()
})
export type UploadUrlView = z.infer<typeof uploadUrlSchema>

const confirmedMediaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  fileSize: z.number(),
  status: z.string()
})
export type ConfirmedMediaView = z.infer<typeof confirmedMediaSchema>

// The signed links of a clean file. They expire (15 minutes), so they are asked when the file is
// drawn and never stored. A variant is null when the file has none (everything but an image).
const mediaUrlsSchema = z.object({
  url: z.url(),
  filename: z.string(),
  contentType: z.string(),
  variants: z.object({
    [ImageVariants.FULL]: z.url().nullable(),
    [ImageVariants.MEDIUM]: z.url().nullable(),
    [ImageVariants.THUMB]: z.url().nullable()
  })
})
export type MediaUrlsView = z.infer<typeof mediaUrlsSchema>

export interface UploadFileInfo {
  filename: string
  contentType: string
  fileSizeBytes: number
}

// Step 1 of an upload: a signed URL to PUT the bytes to. Nothing is stored until the confirmation.
export function requestUploadUrl(
  client: ApiClient,
  storeId: string,
  file: UploadFileInfo
): Promise<UploadUrlView> {
  return client.request(ApiRoutes.media.uploadUrl, {
    method: 'POST',
    body: { purpose: MediaPurpose.MESSAGE, ...file },
    schema: uploadUrlSchema,
    storeId
  })
}

// Step 3: the bytes are in the bucket. The api checks them again, moves them and queues the scan.
export function confirmUpload(
  client: ApiClient,
  storeId: string,
  input: UploadFileInfo & { mediaId: string; key: string }
): Promise<ConfirmedMediaView> {
  return client.request(ApiRoutes.media.confirmUpload, {
    method: 'POST',
    body: { purpose: MediaPurpose.MESSAGE, ...input },
    schema: confirmedMediaSchema,
    storeId
  })
}

export function fetchMediaUrls(
  client: ApiClient,
  storeId: string,
  mediaId: string,
  signal?: AbortSignal
): Promise<MediaUrlsView> {
  return client.request(ApiRoutes.media.byId(mediaId), {
    schema: mediaUrlsSchema,
    storeId,
    signal
  })
}
