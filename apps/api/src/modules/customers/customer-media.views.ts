import type { CursorPage } from '@platform/core/domain'
import {
  type GalleryTab,
  type GalleryType,
  galleryTypeOf,
  GalleryTypes
} from '@platform/core/storage'

// One file of the gallery. The link to download or open it is not here: it is asked from
// `GET /media/:id` when the person presses the button. The only link a list carries is the small
// picture of an image (`thumbUrl`), inline and signed for minutes, so the grid needs no call per tile.
export interface GalleryItem {
  id: string
  type: GalleryTab | null
  filename: string
  contentType: string
  fileSizeBytes: number
  createdAt: string
  // The channel of the conversation the file came in or went out through; null when its message is gone
  channelType: string | null
  // The signed link of the small picture; null for a file that is not an image or whose picture is not made yet
  thumbUrl: string | null
}

export type GalleryCounts = Record<GalleryType, number>

export interface GalleryPage extends CursorPage<GalleryItem> {
  // How many files each tab holds under the search text, whatever tab is open. Only the first page
  // carries it (null on a page that follows a cursor): the numbers do not depend on the cursor, and
  // the client keeps the ones it has.
  counts: GalleryCounts | null
}

export function countsOf(
  groups: { contentType: string; _count: { _all: number } }[]
): GalleryCounts {
  const counts: GalleryCounts = {
    [GalleryTypes.ALL]: 0,
    [GalleryTypes.IMAGE]: 0,
    [GalleryTypes.VIDEO]: 0,
    [GalleryTypes.AUDIO]: 0,
    [GalleryTypes.DOCUMENT]: 0
  }
  for (const group of groups) {
    counts[GalleryTypes.ALL] += group._count._all
    const tab = galleryTypeOf(group.contentType)
    if (tab !== null) counts[tab] += group._count._all
  }
  return counts
}
