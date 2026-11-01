import { z } from 'zod'

import { AllowedContentTypes } from './upload-constants'

// The tabs of the media gallery of a customer (TDD_09 §7). "all" is no filter.
export const GalleryTypes = {
  ALL: 'all',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document'
} as const
export type GalleryType = (typeof GalleryTypes)[keyof typeof GalleryTypes]

export const GalleryLimits = {
  SEARCH_MAX_LENGTH: 100,
  // Files in a ZIP, and their bytes together. A ZIP is built in the worker from the bucket: without
  // a ceiling one request could make it read the whole media of a customer with no end.
  ZIP_MAX_FILES: 500,
  ZIP_MAX_BYTES: 1024 * 1024 * 1024
} as const

export const galleryTypeSchema = z.enum([
  GalleryTypes.ALL,
  GalleryTypes.IMAGE,
  GalleryTypes.VIDEO,
  GalleryTypes.AUDIO,
  GalleryTypes.DOCUMENT
])

// The content types of a tab; null for "all"
export function galleryContentTypes(type: GalleryType): readonly string[] | null {
  switch (type) {
    case GalleryTypes.IMAGE:
      return AllowedContentTypes.IMAGE
    case GalleryTypes.VIDEO:
      return AllowedContentTypes.VIDEO
    case GalleryTypes.AUDIO:
      return AllowedContentTypes.AUDIO
    case GalleryTypes.DOCUMENT:
      return AllowedContentTypes.DOCUMENT
    case GalleryTypes.ALL:
      return null
  }
}

// The tab a stored file belongs to; null for a type no tab lists
export function galleryTypeOf(contentType: string): GalleryTab | null {
  const tabs = [
    GalleryTypes.IMAGE,
    GalleryTypes.VIDEO,
    GalleryTypes.AUDIO,
    GalleryTypes.DOCUMENT
  ] as const
  return tabs.find(tab => galleryContentTypes(tab)?.includes(contentType) === true) ?? null
}

const searchSchema = z.string().trim().min(1).max(GalleryLimits.SEARCH_MAX_LENGTH)

// The body of "Download all": the gallery as the member saw it (a tab and a search). The row of the
// export also freezes who asked (`mediaZipFiltersSchema`, in messaging), because the file holds what
// that member could see.
export const downloadAllBodySchema = z.strictObject({
  customerId: z.uuid(),
  type: galleryTypeSchema.optional(),
  q: searchSchema.optional()
})
export type DownloadAllBody = z.output<typeof downloadAllBodySchema>

export const gallerySearchSchema = searchSchema
// A tab that lists files: every one but "all"
export type GalleryTab = Exclude<GalleryType, typeof GalleryTypes.ALL>
