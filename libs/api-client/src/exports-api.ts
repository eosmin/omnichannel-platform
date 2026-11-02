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
  // 0 to 100 while the file is written; null before the worker has counted and once it is settled
  progress: z.number().int().min(0).max(100).nullable().catch(null),
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

// The customers CSV: queues the file for the search the page shows and answers with its row
export function requestCustomersExport(
  client: ApiClient,
  storeId: string,
  q: string
): Promise<ExportView> {
  const text = q.trim()
  const query = text === '' ? '' : `?${new URLSearchParams({ q: text }).toString()}`
  return client.request(`${ApiRoutes.customers.export}${query}`, {
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
// `type` and `status` are the values of ExportTypes and ExportStatus; null shows all
export interface ExportListFilter {
  type: string | null
  status: string | null
}

export function fetchExports(
  client: ApiClient,
  storeId: string,
  filter: ExportListFilter,
  cursor: string | null,
  signal?: AbortSignal
): Promise<ExportPageView> {
  const params = new URLSearchParams()
  if (filter.type !== null) params.set('type', filter.type)
  if (filter.status !== null) params.set('status', filter.status)
  if (cursor !== null) params.set('cursor', cursor)
  const text = params.toString()
  const query = text === '' ? '' : `?${text}`
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
