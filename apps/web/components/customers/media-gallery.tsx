'use client'

import { useQueryClient } from '@tanstack/react-query'
import { Download, Eye, FileText, Mic, Video } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import { AppPaths, type GalleryCountsView, type GalleryItemView } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { GalleryTypes, type GalleryType } from '@platform/core/storage'

import { useChannelName } from '../../lib/inbox/use-inbox-data'
import { formatBytes } from '../../lib/media/attachment-rules'
import { countsOfPages, isViewable } from '../../lib/media/gallery-view'
import { useDownloadAll, useGallery } from '../../lib/media/use-gallery'
import { fetchMediaUrlsOnDemand, useMediaUrls } from '../../lib/media/use-media-urls'
import { useDebouncedValue } from '../../lib/use-debounced-value'
import { MediaLightbox } from '../inbox/media-lightbox'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

import { MutationError } from './mutation-error'

const SEARCH_DELAY_MS = 300
const TABS: readonly GalleryType[] = [
  GalleryTypes.ALL,
  GalleryTypes.IMAGE,
  GalleryTypes.VIDEO,
  GalleryTypes.AUDIO,
  GalleryTypes.DOCUMENT
]

function Thumbnail({ item }: { item: GalleryItemView }): ReactElement {
  const { storeId } = useStore()
  const isImage = item.type === GalleryTypes.IMAGE
  const urls = useMediaUrls(storeId, item.id, isImage)
  const src = urls.data?.variants.thumb ?? urls.data?.url
  if (isImage && src !== undefined) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a signed link on the bucket host: next/image would need it configured
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-full object-cover"
      />
    )
  }
  const Icon =
    item.type === GalleryTypes.VIDEO ? Video : item.type === GalleryTypes.AUDIO ? Mic : FileText
  return <Icon aria-hidden className="text-muted-foreground size-8" />
}

function Tile({ item, onOpen }: { item: GalleryItemView; onOpen: () => void }): ReactElement {
  const t = useTranslations('customers.gallery')
  const format = useFormatter()
  const queryClient = useQueryClient()
  const { storeId } = useStore()
  const channel = useChannelName(storeId, item.channelType ?? '')
  const [failed, setFailed] = useState(false)

  const download = async (): Promise<void> => {
    setFailed(false)
    try {
      const urls = await fetchMediaUrlsOnDemand(queryClient, storeId, item.id)
      const link = document.createElement('a')
      link.href = urls.url
      link.download = item.filename
      link.rel = 'noopener noreferrer'
      link.target = '_blank'
      link.click()
    } catch {
      setFailed(true)
    }
  }

  return (
    <li className="flex flex-col gap-1 rounded-md border p-2 text-xs">
      <div className="bg-muted flex aspect-square items-center justify-center overflow-hidden rounded">
        <Thumbnail item={item} />
      </div>
      <p className="truncate font-medium" title={item.filename}>
        {item.filename}
      </p>
      <p className="text-muted-foreground">
        {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium' })}
        {' · '}
        {formatBytes(item.fileSizeBytes)}
      </p>
      {item.channelType === null ? null : <p className="text-muted-foreground">{channel}</p>}
      <div className="flex gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t('download', { name: item.filename })}
          onClick={() => void download()}
        >
          <Download aria-hidden />
        </Button>
        {isViewable(item.type) ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t('open', { name: item.filename })}
            onClick={onOpen}
          >
            <Eye aria-hidden />
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="text-destructive">
          {t('downloadFailed')}
        </p>
      ) : null}
    </li>
  )
}

// The lightbox of the gallery: the large variant of an image or the video itself, and the arrows
// walk the files that can be seen (images and videos) in the order of the grid
function GalleryLightbox({
  viewable,
  index,
  onIndex
}: {
  viewable: readonly GalleryItemView[]
  index: number | null
  onIndex: (index: number | null) => void
}): ReactElement {
  const { storeId } = useStore()
  const item = index === null ? undefined : viewable[index]
  const urls = useMediaUrls(storeId, item?.id ?? '', item !== undefined)
  // The dialog stays open while the links of the next file load, so the arrows keep their focus
  const file =
    item === undefined
      ? null
      : {
          kind: item.type === GalleryTypes.VIDEO ? ('video' as const) : ('image' as const),
          src:
            urls.data === undefined
              ? null
              : item.type === GalleryTypes.VIDEO
                ? urls.data.url
                : (urls.data.variants.full ?? urls.data.url),
          downloadUrl: urls.data?.url ?? '',
          filename: item.filename
        }
  const step = (by: number): void => {
    if (index === null || viewable.length === 0) return
    onIndex((index + by + viewable.length) % viewable.length)
  }
  return (
    <MediaLightbox
      file={file}
      onClose={() => onIndex(null)}
      onPrevious={viewable.length > 1 ? () => step(-1) : undefined}
      onNext={viewable.length > 1 ? () => step(1) : undefined}
    />
  )
}

function tabLabel(
  t: ReturnType<typeof useTranslations<'customers.gallery.tabs'>>,
  type: GalleryType,
  counts: GalleryCountsView | null
): string {
  return counts === null ? t(type) : `${t(type)} ${counts[type]}`
}

// The files of one customer (TDD_09 §7): tabs with their counts, a search by file name, a grid with
// download and lightbox, and "Download all", which queues a ZIP of what the filter shows.
export function MediaGallery({
  customerId,
  isOpen,
  onClose
}: {
  customerId: string
  isOpen: boolean
  onClose: () => void
}): ReactElement {
  const t = useTranslations('customers.gallery')
  const tTabs = useTranslations('customers.gallery.tabs')
  const tCommon = useTranslations('common')
  const { storeId, can } = useStore()
  const [type, setType] = useState<GalleryType>(GalleryTypes.ALL)
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search, SEARCH_DELAY_MS)
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const gallery = useGallery(storeId, customerId, type, q)
  const downloadAll = useDownloadAll(storeId, customerId)
  const router = useRouter()

  const pages = gallery.data?.pages ?? []
  const items = pages.flatMap(page => page.data)
  const viewable = items.filter(item => isViewable(item.type))

  // The counts come with the first page of each query: the last ones stay while another tab loads
  const fresh = countsOfPages(pages)
  const [counts, setCounts] = useState<GalleryCountsView | null>(fresh)
  if (fresh !== null && fresh !== counts) setCounts(fresh)

  const maySeeAll = can(Permissions.MEDIA_DOWNLOAD_ALL)
  const isEmpty = gallery.data !== undefined && items.length === 0

  const requestZip = (): void => {
    downloadAll.mutate(
      { type, q },
      {
        onSuccess: () =>
          toast.success(t('zipQueued'), {
            action: {
              label: t('viewExports'),
              onClick: () => router.push(AppPaths.store.exports(storeId))
            }
          })
      }
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] flex-col gap-3 sm:max-w-3xl">
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>
        <Tabs value={type} onValueChange={value => setType(value as GalleryType)}>
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            {TABS.map(tab => (
              <TabsTrigger key={tab} value={tab}>
                {tabLabel(tTabs, tab, counts)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            maxLength={100}
            className="min-w-40 flex-1"
          />
          {maySeeAll ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              // The search is sent as the grid shows it: not while the typing is still settling
              disabled={
                downloadAll.isPending || isEmpty || gallery.data === undefined || search !== q
              }
              onClick={requestZip}
            >
              <Download aria-hidden />
              {t('downloadAll')}
            </Button>
          ) : null}
        </div>
        <MutationError error={downloadAll.error} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {gallery.isError && gallery.data === undefined ? (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p>{t('failed')}</p>
              <Button variant="outline" size="sm" onClick={() => void gallery.refetch()}>
                {tCommon('tryAgain')}
              </Button>
            </div>
          ) : gallery.data === undefined ? (
            <p role="status" className="text-muted-foreground text-sm">
              {tCommon('loading')}
            </p>
          ) : isEmpty ? (
            <p className="text-muted-foreground text-sm">
              {q.trim() === '' ? t('empty') : t('noMatch')}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {items.map(item => (
                <Tile
                  key={item.id}
                  item={item}
                  onOpen={() => setOpenIndex(viewable.findIndex(file => file.id === item.id))}
                />
              ))}
            </ul>
          )}
          {gallery.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={gallery.isFetchingNextPage}
              onClick={() => void gallery.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          ) : null}
        </div>
        <GalleryLightbox viewable={viewable} index={openIndex} onIndex={setOpenIndex} />
      </DialogContent>
    </Dialog>
  )
}
