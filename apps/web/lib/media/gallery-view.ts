import type { GalleryCountsView, GalleryPageView } from '@platform/api-client'
import { GalleryTypes } from '@platform/core/storage'

// The counts of the tabs are on the first page; the pages after it carry none
export function countsOfPages(pages: readonly GalleryPageView[]): GalleryCountsView | null {
  return pages[0]?.counts ?? null
}

// A tile opens in the lightbox when it is an image or a video; audio and documents are downloaded
export function isViewable(type: string | null): boolean {
  return type === GalleryTypes.IMAGE || type === GalleryTypes.VIDEO
}
