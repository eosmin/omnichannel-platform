'use client'

import { type ReactElement, useEffect } from 'react'

import { stepViewerKey, type ViewerItem } from '../../lib/inbox/viewer-items'
import { useMediaUrls } from '../../lib/media/use-media-urls'
import { useStore } from '../providers/store-context'

import { MediaLightbox } from './media-lightbox'

// The viewer of the pictures of a message (an album, or a run of pictures drawn as one block): the one open at
// full size, with the arrows (and the keys) to walk all of them, its place among them for a screen reader and the
// text under each. It is downloaded the first time a picture is opened: the thread has a script budget. The links
// of the two neighbours are read ahead, so that an arrow shows the next picture at once.
export default function ImageSetViewer({
  items,
  openKey,
  onOpenKey
}: {
  items: readonly ViewerItem[]
  openKey: string | null
  onOpenKey: (key: string | null) => void
}): ReactElement {
  const { storeId } = useStore()
  const index = openKey === null ? -1 : items.findIndex(item => item.key === openKey)
  const item = index === -1 ? undefined : items[index]
  // The picture that is open left the list (deleted, or no longer clean): the viewer closes, and does not come
  // back by itself if it returns
  const isGone = openKey !== null && index === -1
  useEffect(() => {
    if (isGone) onOpenKey(null)
  }, [isGone, onOpenKey])
  const walks = items.length > 1 && item !== undefined
  const next = walks ? items[(index + 1) % items.length] : undefined
  const previous = walks ? items[(index - 1 + items.length) % items.length] : undefined
  const urls = useMediaUrls(storeId, item?.mediaId ?? '', item !== undefined)
  // Ahead of the arrow: the answers are kept by the query, so the next picture is there when it is asked for
  useMediaUrls(storeId, next?.mediaId ?? '', next !== undefined)
  useMediaUrls(storeId, previous?.mediaId ?? '', previous !== undefined)
  const step = (by: number): void => {
    if (openKey === null) return
    onOpenKey(stepViewerKey(items, openKey, by))
  }
  return (
    <MediaLightbox
      file={
        item === undefined
          ? null
          : {
              kind: 'image',
              src: urls.data === undefined ? null : (urls.data.variants.full ?? urls.data.url),
              downloadUrl: urls.data?.url ?? '',
              filename: item.filename
            }
      }
      onClose={() => onOpenKey(null)}
      onPrevious={walks ? () => step(-1) : undefined}
      onNext={walks ? () => step(1) : undefined}
      position={{ index: Math.max(index, 0), total: items.length, number: item?.number ?? 1 }}
      caption={item?.caption ?? null}
    />
  )
}
