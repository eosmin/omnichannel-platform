import type { ConversationOriginView } from '@platform/api-client'
import { OriginMediaTypes } from '@platform/core/domain'

type OriginFile = NonNullable<ConversationOriginView['thumbnailFile']>

// The card draws the file of the store, never the address of the ad: the thumbnail, or the media
// itself when it is an image (a video has no frame to draw).
export function pictureFileOf(origin: ConversationOriginView): OriginFile | null {
  return (
    origin.thumbnailFile ?? (origin.mediaType === OriginMediaTypes.IMAGE ? origin.mediaFile : null)
  )
}
