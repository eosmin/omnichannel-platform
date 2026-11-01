import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { GalleryTypes, type GalleryType } from '@platform/core/storage'

import type { ApiClient } from './api-client'

const galleryTabSchema = z.enum([
  GalleryTypes.IMAGE,
  GalleryTypes.VIDEO,
  GalleryTypes.AUDIO,
  GalleryTypes.DOCUMENT
])

// One file of the gallery. Never a link: the signed one is asked from `GET /media/:id` when the file
// is opened or downloaded, because it lasts minutes.
export const galleryItemSchema = z.object({
  id: z.string(),
  // A type this page does not know (a newer server) has no tab: it is listed under "all" only
  type: galleryTabSchema.nullable().catch(null),
  filename: z.string(),
  contentType: z.string(),
  fileSizeBytes: z.number(),
  createdAt: z.string(),
  channelType: z.string().nullable()
})
export type GalleryItemView = z.output<typeof galleryItemSchema>

const galleryCountsSchema = z.object({
  [GalleryTypes.ALL]: z.number(),
  [GalleryTypes.IMAGE]: z.number(),
  [GalleryTypes.VIDEO]: z.number(),
  [GalleryTypes.AUDIO]: z.number(),
  [GalleryTypes.DOCUMENT]: z.number()
})
export type GalleryCountsView = z.output<typeof galleryCountsSchema>

// `counts` comes on the first page only (null on the pages after a cursor): the client keeps the ones
// it has
export const galleryPageSchema = z.object({
  data: z.array(galleryItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  counts: galleryCountsSchema.nullable()
})
export type GalleryPageView = z.output<typeof galleryPageSchema>

function queryOf(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, value)
  }
  const text = query.toString()
  return text === '' ? '' : `?${text}`
}

export function fetchCustomerMedia(
  client: ApiClient,
  storeId: string,
  customerId: string,
  filter: { type: GalleryType; q: string },
  cursor: string | null,
  signal?: AbortSignal
): Promise<GalleryPageView> {
  const query = queryOf({
    type: filter.type === GalleryTypes.ALL ? undefined : filter.type,
    q: filter.q.trim(),
    cursor: cursor ?? undefined
  })
  return client.request(`${ApiRoutes.customers.media(customerId)}${query}`, {
    schema: galleryPageSchema,
    storeId,
    signal
  })
}
