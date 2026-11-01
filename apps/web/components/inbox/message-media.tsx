'use client'

import { FileText, LoaderCircle, Mic, Play, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useState } from 'react'

import type { MessageView } from '@platform/api-client'
import { MediaStatus, MediaUnavailableCodes, MessageType } from '@platform/core/domain'
import { mediaMessageTypeOf } from '@platform/core/storage'

import { formatBytes } from '../../lib/media/attachment-rules'
import { useMediaUrls } from '../../lib/media/use-media-urls'
import { useStore } from '../providers/store-context'

import { type LightboxFile, MediaLightbox } from './media-lightbox'

type MediaFile = MessageView['media'][number]
type UnavailableFile = MessageView['unavailableFiles'][number]

// The files of a message, each in the state its scan is in. The signed links are asked from the api
// when the file is clean and drawn at once; the list of the thread never carries a link.
export function MessageMedia({
  files,
  unavailable
}: {
  files: readonly MediaFile[]
  unavailable: readonly UnavailableFile[]
}): ReactElement | null {
  const [open, setOpen] = useState<LightboxFile | null>(null)
  if (files.length === 0 && unavailable.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {files.map(file => (
        <MediaItem key={file.id} file={file} onOpen={setOpen} />
      ))}
      {unavailable.map(file => (
        <UnavailableItem key={file.index} code={file.code} />
      ))}
      <MediaLightbox file={open} onClose={() => setOpen(null)} />
    </div>
  )
}

function Frame({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="bg-background/60 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
      {children}
    </div>
  )
}

// A code of a newer server reads as the generic one
function reasonOf(
  code: string,
  t: ReturnType<typeof useTranslations<'inbox.thread.media.notKept'>>
): string {
  switch (code) {
    case MediaUnavailableCodes.REFUSED:
      return t('refused')
    case MediaUnavailableCodes.UNSAFE_LINK:
      return t('unsafe_link')
    case MediaUnavailableCodes.CHANNEL_CANNOT_FETCH:
      return t('channel_cannot_fetch')
    default:
      return t('fetch_failed')
  }
}

// A file the customer sent that the platform could not keep. It was never stored, so there is nothing to
// retry from here: the line says why, in words of the agent.
function UnavailableItem({ code }: { code: string }): ReactElement {
  const t = useTranslations('inbox.thread.media.notKept')
  return (
    <Frame>
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      <span role="status" className="min-w-0 break-words">
        {reasonOf(code, t)}
      </span>
    </Frame>
  )
}

function MediaItem({
  file,
  onOpen
}: {
  file: MediaFile
  onOpen: (file: LightboxFile) => void
}): ReactElement {
  const t = useTranslations('inbox.thread.media')
  const { storeId } = useStore()
  const isClean = file.status === MediaStatus.CLEAN
  const urls = useMediaUrls(storeId, file.id, isClean)
  const kind = mediaMessageTypeOf(file.contentType)

  if (file.status === MediaStatus.INFECTED) {
    return (
      <Frame>
        <ShieldAlert aria-hidden className="text-destructive size-4 shrink-0" />
        <span role="status" className="min-w-0 break-words">
          {t('infected', { name: file.filename })}
        </span>
      </Frame>
    )
  }
  if (!isClean) {
    return (
      <Frame>
        <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
        <span role="status" className="min-w-0 break-words">
          {t('checking', { name: file.filename })}
        </span>
      </Frame>
    )
  }
  if (urls.isError) {
    return (
      <Frame>
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        <span role="status" className="min-w-0 break-words">
          {t('unavailable', { name: file.filename })}
        </span>
        <button
          type="button"
          className="focus-visible:ring-ring ml-auto rounded underline outline-none focus-visible:ring-2"
          onClick={() => void urls.refetch()}
        >
          {t('retry')}
        </button>
      </Frame>
    )
  }
  if (urls.data === undefined) {
    return (
      <Frame>
        <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
        <span className="min-w-0 break-words">{t('loading', { name: file.filename })}</span>
      </Frame>
    )
  }

  const { data } = urls
  if (kind === MessageType.IMAGE) {
    // The thumbnail is 160 px: the medium one fills the bubble; an image with no variant (the decoder
    // refused it) is not drawn inline, it is a download
    const preview = data.variants.medium ?? data.variants.thumb
    if (preview !== null) {
      const large = data.variants.full ?? preview
      return (
        <button
          type="button"
          aria-label={t('open', { name: file.filename })}
          className="focus-visible:ring-ring overflow-hidden rounded-md outline-none focus-visible:ring-2"
          onClick={() =>
            onOpen({ kind: 'image', src: large, downloadUrl: data.url, filename: file.filename })
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed link on the bucket host */}
          <img
            src={preview}
            alt={file.filename}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="max-h-64 w-full object-cover"
          />
        </button>
      )
    }
  }
  if (kind === MessageType.VIDEO) {
    return (
      <button
        type="button"
        aria-label={t('play', { name: file.filename })}
        className="bg-muted focus-visible:ring-ring flex items-center gap-2 rounded-md border px-3 py-3 text-xs outline-none focus-visible:ring-2"
        onClick={() =>
          onOpen({ kind: 'video', src: data.url, downloadUrl: data.url, filename: file.filename })
        }
      >
        <Play aria-hidden className="size-5 shrink-0" />
        <span className="min-w-0 truncate">{file.filename}</span>
        <span className="text-muted-foreground shrink-0">{formatBytes(file.fileSize)}</span>
      </button>
    )
  }
  if (kind === MessageType.AUDIO) {
    return (
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-xs">
          <Mic aria-hidden className="size-3.5" />
          <span className="min-w-0 truncate">{file.filename}</span>
        </p>
        <audio
          src={data.url}
          controls
          preload="none"
          aria-label={file.filename}
          className="w-full"
        />
      </div>
    )
  }
  return (
    <a
      href={data.url}
      download={file.filename}
      target="_blank"
      rel="noopener noreferrer"
      className="focus-visible:ring-ring bg-background/60 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs outline-none hover:underline focus-visible:ring-2"
    >
      <FileText aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{file.filename}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.fileSize)}</span>
      <span className="sr-only">{t('downloadFile', { name: file.filename })}</span>
    </a>
  )
}
