import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { GalleryTypes, type GalleryType } from '@platform/core/storage'

import type { ApiClient } from './api-client'

// An export row as the api tells it. `type` and `status` stay text: a value this page does not know
// (a newer server) must still draw, and the page maps the ones it knows.
export const exportSchema = z.object({
  id: z.string(),
  type: z.string(),
  format: z.string(),
  status: z.string(),
  filename: z.string().nullable(),
  rowCount: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  expiresAt: z.string()
})
export type ExportView = z.output<typeof exportSchema>

// "Download all" of the gallery: queues the ZIP of what the filter shows and answers with its row
export function requestMediaZip(
  client: ApiClient,
  storeId: string,
  input: { customerId: string; type: GalleryType; q: string }
): Promise<ExportView> {
  const q = input.q.trim()
  return client.request(ApiRoutes.media.downloadAll, {
    method: 'POST',
    body: {
      customerId: input.customerId,
      // "all" is no filter: the api takes the field out
      ...(input.type === GalleryTypes.ALL ? {} : { type: input.type }),
      ...(q === '' ? {} : { q })
    },
    schema: exportSchema,
    storeId
  })
}

export const exportPageSchema = z.object({
  data: z.array(exportSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type ExportPageView = z.output<typeof exportPageSchema>

// The exports center: the files this member asked for, newest first
export function fetchExports(
  client: ApiClient,
  storeId: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<ExportPageView> {
  const query = cursor === null ? '' : `?${new URLSearchParams({ cursor }).toString()}`
  return client.request(`${ApiRoutes.exports.list}${query}`, {
    schema: exportPageSchema,
    storeId,
    signal
  })
}

// A signed link with `Content-Disposition: attachment`, asked each time: it lasts minutes
const exportDownloadSchema = z.object({
  url: z.url(),
  filename: z.string(),
  expiresInSeconds: z.number()
})
export type ExportDownloadView = z.output<typeof exportDownloadSchema>

export function fetchExportDownload(
  client: ApiClient,
  storeId: string,
  exportId: string
): Promise<ExportDownloadView> {
  return client.request(ApiRoutes.exports.download(exportId), {
    schema: exportDownloadSchema,
    storeId
  })
}
