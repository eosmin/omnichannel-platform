'use client'

import { FileText, ImageIcon, Mic, Play, ShieldAlert, TriangleAlert, Video } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useState } from 'react'

import type { MessageView } from '@platform/api-client'
import { MediaStatus, MediaUnavailableCodes, MessageType } from '@platform/core/domain'
import type { OutboundMediaType } from '@platform/core/storage'

import { fileDeliveryOf, isAlbum, sayRetryOnlyFailed } from '../../lib/inbox/album'
import type { AlbumCaptionLine } from '../../lib/inbox/file-caption'
import { displayFileNameOf } from '../../lib/inbox/file-label'
import { mediaKindOf } from '../../lib/inbox/media-kind'
import {
  type FileType,
  fileStateOf,
  isFileType,
  isWaitingState,
  pendingShapeOf
} from '../../lib/inbox/media-state'
import { useMessageMutations } from '../../lib/inbox/use-message-actions'
import { formatBytes } from '../../lib/media/attachment-rules'
import { useMediaUrlReads, useMediaUrls } from '../../lib/media/use-media-urls'
import { hasGivenUpWaiting, isWaitingForVariants } from '../../lib/media/variant-wait'
import { toast } from '../../lib/toast'
import { useCodeText, useErrorText } from '../../lib/use-error-text'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'

import { AlbumCaptionList, AlbumCaptionMark } from './album-captions'
import { FileCaption } from './file-caption'
import { type LightboxFile, MediaLightbox } from './media-lightbox'

// A file is drawn in one of two states, a skeleton or its content, and both fill the same box, so the
// thread never jumps when the file arrives. The rare end states (infected, not scannable, not
// available) keep their text inside the same box. The size of a box depends on the kind of file only,
// because the size of the picture is not known before its links are read. The skeleton starts on the first
// frame of the message, before the file exists (`PendingMedia`), and the states of a file that exists come
// from one function (`fileStateOf`).
// The widths are fixed with `max-w-full`, not `min(320px, 100%)`: a bubble is as wide as its content, so
// a percentage has nothing to resolve against and the box would shrink to the width of the clock.
const Boxes = {
  IMAGE: 'aspect-[4/3] w-[320px] max-w-full',
  STICKER: 'size-32',
  // A picture of an album: the two columns of its grid share the width of one picture
  CELL: 'aspect-square w-full',
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
  canResendCaption = false,
  sticker = false,
  messageType,
  albumCaptions
}: {
  files: readonly MediaFile[]
  unavailable: readonly UnavailableFile[]
  messageId: string
  conversationId: string
  canRefetch: boolean
  // The agent may send the text under a file again
  canResendCaption?: boolean
  sticker?: boolean
  // The type of the message: a voice note that is an mp4 is drawn by the player of audio (`mediaKindOf`)
  messageType: string
  // The texts of the album as a list in the order of the pictures, each number on its picture, with the text of
  // the message (the first picture's) as `lead`. Without it, each text is drawn under its own file.
  albumCaptions?: { lines: readonly AlbumCaptionLine<MediaFile>[]; lead: ReactNode }
}): ReactElement | null {
  const [open, setOpen] = useState<LightboxFile | null>(null)
  if (files.length === 0 && unavailable.length === 0) return null
  // Several pictures in one message are a grid; the state of each file shows under it once there are several
  const album = isAlbum(files, messageType, sticker)
  const states = files.length > 1
  const numbers = new Map(albumCaptions?.lines.map(line => [line.file.id, line.number]))
  return (
    <div className="flex flex-col gap-1.5">
      <div className={album ? 'grid w-[320px] max-w-full grid-cols-2 gap-1' : 'contents'}>
        {files.map(file => (
          <div key={file.id} className="relative flex min-w-0 flex-col gap-0.5">
            <MarkOf number={numbers.get(file.id)} />
            <MediaItem
              file={file}
              onOpen={setOpen}
              sticker={sticker}
              messageType={messageType}
              inAlbum={album}
            />
            {states ? <FileDeliveryLine file={file} /> : null}
            {albumCaptions === undefined ? (
              <FileCaption
                file={file}
                messageId={messageId}
                conversationId={conversationId}
                canResend={canResendCaption}
              />
            ) : null}
          </div>
        ))}
      </div>
      {albumCaptions === undefined ? null : (
        <AlbumCaptionList
          lines={albumCaptions.lines}
          lead={albumCaptions.lead}
          messageId={messageId}
          conversationId={conversationId}
          canResend={canResendCaption}
        />
      )}
      {sayRetryOnlyFailed(files) ? <RetryHint /> : null}
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

function MarkOf({ number }: { number: number | undefined }): ReactElement | null {
  return number === undefined ? null : <AlbumCaptionMark number={number} />
}

// One picture of a run of pictures a customer sent one after the other (each its own message): the cell of the
// grid, with the states of any picture. What opens it is the viewer of the run, which walks all of them.
export function RunImage({ file, onOpen }: { file: MediaFile; onOpen: () => void }): ReactElement {
  return (
    <MediaItem
      file={file}
      onOpen={() => onOpen()}
      sticker={false}
      messageType={MessageType.IMAGE}
      inAlbum
    />
  )
}

const KIND_LABELS = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] as const

// The icon in front of the word of a kind of file: a kind with no icon does not compile
const KIND_ICONS: Record<FileType, typeof FileText> = {
  [MessageType.IMAGE]: ImageIcon,
  [MessageType.VIDEO]: Video,
  [MessageType.AUDIO]: Mic,
  [MessageType.DOCUMENT]: FileText
}

// The label of a kind of file; a kind the page has no label for reads as a document
function labelOf(
  t: ReturnType<typeof useTranslations<'inbox.thread.mediaLabel'>>,
  type: string
): string {
  return t(KIND_LABELS.find(label => label === type) ?? 'DOCUMENT')
}

type Shape = 'image' | 'sticker' | 'cell' | 'pill'

const BOX_OF: Record<Shape, string> = {
  image: Boxes.IMAGE,
  sticker: Boxes.STICKER,
  cell: Boxes.CELL,
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

// A message that is a file and has none. While the file of a customer's message may still be on the way
// (`awaiting`, from `useAwaitingFiles`: the worker stores the message first and fetches the file after) it is
// the skeleton of the box the file will fill, from the first frame, so that no word takes the place of the
// box for a moment. After that window, or for any other author, it is the word of its kind, as it always was.
export function PendingMedia({
  type,
  awaiting,
  sticker
}: {
  type: string
  awaiting: boolean
  sticker: boolean
}): ReactElement | null {
  const t = useTranslations('inbox.thread.media')
  const tKind = useTranslations('inbox.thread.mediaLabel')
  if (!isFileType(type)) return null
  if (!awaiting) {
    const Icon = KIND_ICONS[type]
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Icon aria-hidden className="size-4" />
        {labelOf(tKind, type)}
      </p>
    )
  }
  const skeleton = <Skeleton shape={pendingShapeOf(type, sticker)} text={t('arriving')} />
  if (type !== MessageType.AUDIO) return skeleton
  // The name of a voice note sits over its player in every state, so the box is the same height
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-xs">
        <Mic aria-hidden className="size-3.5" />
        <span className="min-w-0 truncate">{labelOf(tKind, type)}</span>
      </p>
      {skeleton}
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

// What the agent has to know about a file of a reply: that it waits, or that it failed and why. A file that went
// out is told by the ticks of the message.
function FileDeliveryLine({ file }: { file: MediaFile }): ReactElement | null {
  const t = useTranslations('inbox.thread.media')
  const codeText = useCodeText()
  const state = fileDeliveryOf(file)
  if (state === null) return null
  return (
    // Plain text, not a live region: a thread full of old albums must not announce every failure it holds
    <p
      className={cn(
        'text-xs break-words',
        state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {state === 'queued'
        ? t('fileQueued')
        : file.errorCode === null
          ? t('fileFailed')
          : t('fileFailedWithReason', { reason: codeText(file.errorCode) })}
    </p>
  )
}

// What sending again does with the files that failed, said without naming a button the viewer may not have
function RetryHint(): ReactElement {
  const t = useTranslations('inbox.thread.media')
  return <p className="text-muted-foreground text-xs">{t('retryOnlyFailed')}</p>
}

function MediaItem({
  file,
  onOpen,
  sticker,
  messageType,
  inAlbum
}: {
  file: MediaFile
  onOpen: (file: LightboxFile) => void
  sticker: boolean
  messageType: string
  inAlbum: boolean
}): ReactElement {
  const tKind = useTranslations('inbox.thread.mediaLabel')
  const kind = mediaKindOf(messageType, file.contentType)
  // A file with no name of its own is called by its kind (Audio, Imagen, Documento), not "file"
  const shown = displayFileNameOf(file.filename, kind ?? '')
  const name = shown.kind === 'name' ? shown.name : labelOf(tKind, shown.type)
  const body = (
    <MediaBody
      file={file}
      onOpen={onOpen}
      sticker={sticker}
      kind={kind}
      name={name}
      inAlbum={inAlbum}
    />
  )
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
  name,
  inAlbum
}: {
  file: MediaFile
  onOpen: (file: LightboxFile) => void
  sticker: boolean
  kind: OutboundMediaType | null
  name: string
  inAlbum: boolean
}): ReactElement {
  const t = useTranslations('inbox.thread.media')
  const { storeId } = useStore()
  const isClean = file.status === MediaStatus.CLEAN
  const urls = useMediaUrls(storeId, file.id, isClean)
  const shape: Shape =
    kind === MessageType.IMAGE ? (sticker ? 'sticker' : inAlbum ? 'cell' : 'image') : 'pill'
  // The variants of a picture come a moment after the picture is clean. The box waits for them until
  // the links were read as many times as the wait allows; the count is kept by the query, so a picture
  // drawn again does not start the wait over, and the read that ends it is a render of its own.
  const reads = useMediaUrlReads(storeId, file.id, urls)
  const data = urls.data
  // The thumbnail is 160 px: the medium one fills the box
  const preview = data === undefined ? null : (data.variants.medium ?? data.variants.thumb)
  const state = fileStateOf({
    status: file.status,
    linksFailed: urls.isError,
    linksRead: data !== undefined,
    waitingForVariants:
      data !== undefined &&
      kind === MessageType.IMAGE &&
      isWaitingForVariants({
        processed: data.processed,
        hasPreview: preview !== null,
        givenUp: hasGivenUpWaiting(reads)
      })
  })

  if (state === 'infected') {
    return (
      <Frame shape={shape}>
        <ShieldAlert aria-hidden className="text-destructive size-4 shrink-0" />
        <span role="status" className="min-w-0 break-words">
          {t('infected', { name })}
        </span>
      </Frame>
    )
  }
  if (state === 'unscannable') {
    return (
      <Frame shape={shape}>
        <TriangleAlert aria-hidden className="text-destructive size-4 shrink-0" />
        <span role="status" className="min-w-0 break-words">
          {t('unscannable', { name })}
        </span>
      </Frame>
    )
  }
  if (state === 'unreadable') {
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
  if (isWaitingState(state) || data === undefined) {
    return (
      <Skeleton shape={shape} text={t(state === 'scanning' ? 'checking' : 'loading', { name })} />
    )
  }

  if (kind === MessageType.IMAGE) {
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
