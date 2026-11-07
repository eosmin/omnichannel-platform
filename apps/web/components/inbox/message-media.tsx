'use client'

import { FileText, Mic, Play, ShieldAlert, TriangleAlert } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useState } from 'react'

import type { MessageView } from '@platform/api-client'
import { MediaStatus, MediaUnavailableCodes, MessageType } from '@platform/core/domain'
import type { OutboundMediaType } from '@platform/core/storage'

import { displayFileNameOf } from '../../lib/inbox/file-label'
import { mediaKindOf } from '../../lib/inbox/media-kind'
import { useMessageMutations } from '../../lib/inbox/use-message-actions'
import { formatBytes } from '../../lib/media/attachment-rules'
import { useMediaUrlReads, useMediaUrls } from '../../lib/media/use-media-urls'
import { hasGivenUpWaiting, isWaitingForVariants } from '../../lib/media/variant-wait'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'

import { type LightboxFile, MediaLightbox } from './media-lightbox'

// A file is drawn in one of two states, a skeleton or its content, and both fill the same box, so the
// thread never jumps when the file arrives. The rare end states (infected, not scannable, not
// available) keep their text inside the same box. The size of a box depends on the kind of file only,
// because the size of the picture is not known before its links are read.
// The widths are fixed with `max-w-full`, not `min(320px, 100%)`: a bubble is as wide as its content, so
// a percentage has nothing to resolve against and the box would shrink to the width of the clock.
const Boxes = {
  IMAGE: 'aspect-[4/3] w-[320px] max-w-full',
  STICKER: 'size-32',
  // A document, a video and the voice note share one pill: the player is as wide and as high
  PILL: 'h-10 w-[260px] max-w-full'
} as const

// The player loads when the first voice note is drawn: the inbox has a script budget
// (apps/web-e2e/lighthouse/budgets.ts) and most threads have none. Its placeholder is the same
// skeleton the rest of the files use, with the size of the player.
const AudioPlayer = dynamic(() => import('./audio-player'), {
  ssr: false,
  loading: () => (
    <div aria-hidden className={cn(Boxes.PILL, 'bg-muted animate-pulse rounded-full')} />
  )
})

type MediaFile = MessageView['media'][number]
type UnavailableFile = MessageView['unavailableFiles'][number]

// The files of a message, each in the state its scan is in. The signed links are asked from the api
// when the file is clean and drawn at once; the list of the thread never carries a link. A sticker has
// no bubble around it: `sticker` says the message is one.
export function MessageMedia({
  files,
  unavailable,
  messageId,
  conversationId,
  canRefetch,
  sticker = false,
  messageType
}: {
  files: readonly MediaFile[]
  unavailable: readonly UnavailableFile[]
  messageId: string
  conversationId: string
  canRefetch: boolean
  sticker?: boolean
  // The type of the message: a voice note that is an mp4 is drawn by the player of audio (`mediaKindOf`)
  messageType: string
}): ReactElement | null {
  const [open, setOpen] = useState<LightboxFile | null>(null)
  if (files.length === 0 && unavailable.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {files.map(file => (
        <MediaItem
          key={file.id}
          file={file}
          onOpen={setOpen}
          sticker={sticker}
          messageType={messageType}
        />
      ))}
      {unavailable.map(file => (
        <UnavailableItem
          key={file.index}
          file={file}
          messageId={messageId}
          conversationId={conversationId}
          canRefetch={canRefetch}
        />
      ))}
      <MediaLightbox file={open} onClose={() => setOpen(null)} />
    </div>
  )
}

const KIND_LABELS = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] as const

// The label of a kind of file; a kind the page has no label for reads as a document
function labelOf(
  t: ReturnType<typeof useTranslations<'inbox.thread.mediaLabel'>>,
  type: string
): string {
  return t(KIND_LABELS.find(label => label === type) ?? 'DOCUMENT')
}

type Shape = 'image' | 'sticker' | 'pill'

const BOX_OF: Record<Shape, string> = {
  image: Boxes.IMAGE,
  sticker: Boxes.STICKER,
  pill: Boxes.PILL
}

// The first state: the box of the file, with a pulse and the words for a screen reader
function Skeleton({ shape, text }: { shape: Shape; text: string }): ReactElement {
  return (
    <div
      role="status"
      className={cn(
        BOX_OF[shape],
        'bg-muted animate-pulse border',
        shape === 'pill' ? 'rounded-full' : 'rounded-md'
      )}
    >
      <span className="sr-only">{text}</span>
    </div>
  )
}

// An end state with words: the text sits inside the box the file would fill
function Frame({ shape, children }: { shape: Shape; children: ReactNode }): ReactElement {
  return (
    <div
      className={cn(
        // A line of words may need more height than the pill has, so the pill grows from its height
        shape === 'pill' ? 'min-h-10 w-[260px] max-w-full' : BOX_OF[shape],
        'bg-background/60 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs'
      )}
    >
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

// A file the customer sent that the platform could not keep: the line says why, in words of the agent,
// and, when the provider simply did not hand it over, the button asks the worker for it again (the api
// checks the permission and that the file can be asked for again).
function UnavailableItem({
  file,
  messageId,
  conversationId,
  canRefetch
}: {
  file: UnavailableFile
  messageId: string
  conversationId: string
  canRefetch: boolean
}): ReactElement {
  const t = useTranslations('inbox.thread.media.notKept')
  const errorText = useErrorText()
  const { refetchFile } = useMessageMutations(conversationId, messageId)
  return (
    <Frame shape="pill">
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      <span role="status" className="min-w-0 break-words">
        {reasonOf(file.code, t)}
      </span>
      {canRefetch && file.canRetry ? (
        <button
          type="button"
          className="focus-visible:ring-ring ml-auto rounded underline outline-none focus-visible:ring-2 disabled:opacity-50"
          disabled={refetchFile.isPending}
          onClick={() => {
            refetchFile
              .mutateAsync(file.index)
              .then(() => toast.success(t('refetchRequested')))
              .catch((error: unknown) => toast.error(errorText(error)))
          }}
        >
          {t('refetch')}
        </button>
      ) : null}
    </Frame>
  )
}

function MediaItem({
  file,
  onOpen,
  sticker,
  messageType
}: {
  file: MediaFile
  onOpen: (file: LightboxFile) => void
  sticker: boolean
  messageType: string
}): ReactElement {
  const tKind = useTranslations('inbox.thread.mediaLabel')
  const kind = mediaKindOf(messageType, file.contentType)
  // A file with no name of its own is called by its kind (Audio, Imagen, Documento), not "file"
  const shown = displayFileNameOf(file.filename, kind ?? '')
  const name = shown.kind === 'name' ? shown.name : labelOf(tKind, shown.type)
  const body = <MediaBody file={file} onOpen={onOpen} sticker={sticker} kind={kind} name={name} />
  if (kind !== MessageType.AUDIO) return body
  // The name of a voice note sits over its player in every state, so the box is the same height
  // whether it shows the skeleton, the player or a line of words
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-xs">
        <Mic aria-hidden className="size-3.5" />
        <span className="min-w-0 truncate">{name}</span>
      </p>
      {body}
    </div>
  )
}

function MediaBody({
  file,
  onOpen,
  sticker,
  kind,
  name
}: {
  file: MediaFile
  onOpen: (file: LightboxFile) => void
  sticker: boolean
  kind: OutboundMediaType | null
  name: string
}): ReactElement {
  const t = useTranslations('inbox.thread.media')
  const { storeId } = useStore()
  const isClean = file.status === MediaStatus.CLEAN
  const urls = useMediaUrls(storeId, file.id, isClean)
  const shape: Shape = kind === MessageType.IMAGE ? (sticker ? 'sticker' : 'image') : 'pill'
  // The variants of a picture come a moment after the picture is clean. The box waits for them until
  // the links were read as many times as the wait allows; the count is kept by the query, so a picture
  // drawn again does not start the wait over, and the read that ends it is a render of its own.
  const reads = useMediaUrlReads(storeId, file.id, urls)

  if (file.status === MediaStatus.INFECTED) {
    return (
      <Frame shape={shape}>
        <ShieldAlert aria-hidden className="text-destructive size-4 shrink-0" />
        <span role="status" className="min-w-0 break-words">
          {t('infected', { name })}
        </span>
      </Frame>
    )
  }
  if (file.status === MediaStatus.UNSCANNABLE) {
    return (
      <Frame shape={shape}>
        <TriangleAlert aria-hidden className="text-destructive size-4 shrink-0" />
        <span role="status" className="min-w-0 break-words">
          {t('unscannable', { name })}
        </span>
      </Frame>
    )
  }
  if (!isClean) return <Skeleton shape={shape} text={t('checking', { name })} />
  if (urls.isError) {
    return (
      <Frame shape={shape}>
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        <span role="status" className="min-w-0 break-words">
          {t('unavailable', { name })}
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
  if (urls.data === undefined) return <Skeleton shape={shape} text={t('loading', { name })} />

  const { data } = urls
  // The thumbnail is 160 px: the medium one fills the box
  const preview = data.variants.medium ?? data.variants.thumb
  if (kind === MessageType.IMAGE) {
    if (
      isWaitingForVariants({
        processed: data.processed,
        hasPreview: preview !== null,
        givenUp: hasGivenUpWaiting(reads)
      })
    ) {
      return <Skeleton shape={shape} text={t('loading', { name })} />
    }
    // An image with no variant (the decoder refused it) is not drawn inline, it is a download
    if (preview !== null) {
      const large = data.variants.full ?? preview
      return (
        <button
          type="button"
          aria-label={t('open', { name })}
          className={cn(
            BOX_OF[shape],
            'focus-visible:ring-ring overflow-hidden rounded-md outline-none focus-visible:ring-2',
            // A sticker has transparent corners: a muted square behind it would show
            sticker ? 'bg-transparent' : 'bg-muted'
          )}
          onClick={() =>
            onOpen({
              kind: 'image',
              src: large,
              downloadUrl: data.url,
              filename: file.filename
            })
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed link on the bucket host */}
          <img
            src={preview}
            alt={name}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={cn('size-full', sticker ? 'object-contain' : 'object-cover')}
          />
        </button>
      )
    }
  }
  if (kind === MessageType.VIDEO) {
    return (
      <button
        type="button"
        aria-label={t('play', { name })}
        className={cn(
          Boxes.PILL,
          'bg-muted focus-visible:ring-ring flex items-center gap-2 rounded-md border px-3 text-xs outline-none focus-visible:ring-2'
        )}
        onClick={() =>
          onOpen({
            kind: 'video',
            src: data.url,
            downloadUrl: data.url,
            filename: file.filename
          })
        }
      >
        <Play aria-hidden className="size-5 shrink-0" />
        <span className="min-w-0 truncate">{name}</span>
        <span className="text-muted-foreground shrink-0">{formatBytes(file.fileSize)}</span>
      </button>
    )
  }
  if (kind === MessageType.AUDIO) return <AudioPlayer src={data.url} label={name} />
  return (
    <a
      href={data.url}
      download={file.filename}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        Boxes.PILL,
        'focus-visible:ring-ring bg-background/60 flex items-center gap-2 rounded-md border px-2 text-xs outline-none hover:underline focus-visible:ring-2'
      )}
    >
      <FileText aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.fileSize)}</span>
      <span className="sr-only">{t('downloadFile', { name })}</span>
    </a>
  )
}
