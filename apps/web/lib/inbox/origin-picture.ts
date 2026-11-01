import type { ConversationOriginView } from '@platform/api-client'
import { MediaStatus, OriginMediaTypes } from '@platform/core/domain'

type OriginFile = NonNullable<ConversationOriginView['thumbnailFile']>

// The card draws the file of the store, never the address of the ad: the thumbnail, or the media
// itself when it is an image (a video has no frame to draw).
export function pictureFileOf(origin: ConversationOriginView): OriginFile | null {
  return (
    origin.thumbnailFile ?? (origin.mediaType === OriginMediaTypes.IMAGE ? origin.mediaFile : null)
  )
}

// A picture that is not there yet, or that the scan has not cleared, is asked for again while the origin
// is recent: a fetch that never ends must not keep the inbox asking for as long as it stays open. After
// the window the card shows what the next load brings (accepted: no event announces the end of a scan
// of an ad, see the plan).
export const ORIGIN_REFRESH_MS = 3000
export const ORIGIN_REFRESH_WINDOW_MS = 5 * 60_000

export function originsNeedRefresh(
  origins: readonly ConversationOriginView[] | undefined,
  now: number
): boolean {
  return (
    origins?.some(origin => {
      if (now - Date.parse(origin.createdAt) >= ORIGIN_REFRESH_WINDOW_MS) return false
      const file = pictureFileOf(origin)
      if (file !== null) return file.status === String(MediaStatus.PENDING)
      // No file yet: the worker may not have fetched it. An origin with a link to a picture is asked
      // again for the window; one with no link has nothing to wait for.
      return (
        origin.thumbnailUrl !== null ||
        (origin.mediaType === OriginMediaTypes.IMAGE && origin.mediaUrl !== null)
      )
    }) ?? false
  )
}
