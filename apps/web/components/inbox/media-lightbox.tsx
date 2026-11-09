'use client'

import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Button } from '../ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

export interface LightboxFile {
  kind: 'image' | 'video'
  // What is shown: the large variant of an image, the file itself for a video
  src: string | null
  // The original, to download
  downloadUrl: string
  filename: string
  // The file an image opens by, so that the thread can open the viewer that walks the pictures of its message
  mediaId?: string
}

// A file at full size over the thread. Radix gives it the focus trap, Escape and the return of the
// focus to the thumbnail that opened it.
export function MediaLightbox({
  file,
  onClose,
  onPrevious,
  onNext,
  position,
  caption
}: {
  file: LightboxFile | null
  onClose: () => void
  // The gallery walks its files with the arrows; the thread opens one file and passes neither
  onPrevious?: () => void
  onNext?: () => void
  // Where the file stands among the ones the arrows walk (`index` from 0), said to a screen reader as it changes;
  // `number` is the one its thumbnail wears, drawn before its text
  position?: { index: number; total: number; number: number }
  // The text under the file, drawn with its number in the walk
  caption?: string | null
}): ReactElement {
  const t = useTranslations('inbox.thread.media')
  const canWalk = onPrevious !== undefined || onNext !== undefined
  return (
    <Dialog open={file !== null} onOpenChange={open => (open ? undefined : onClose())}>
      {file === null ? null : (
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] flex-col gap-3 p-4 sm:max-w-4xl"
          onKeyDown={event => {
            // A video keeps the arrows for its own seek bar
            if (event.target instanceof HTMLVideoElement) return
            // Alt/Cmd + arrow is the browser's back and forward: the picture does not move with it
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            if (event.key === 'ArrowLeft' && onPrevious !== undefined) onPrevious()
            if (event.key === 'ArrowRight' && onNext !== undefined) onNext()
          }}
        >
          <DialogTitle className="truncate pr-8 text-base">{file.filename}</DialogTitle>
          {/* Radix points aria-describedby of the dialog at this line: how to close it and, where there are
              several files, how to walk them */}
          <DialogDescription className="sr-only">
            {t(canWalk ? 'lightboxHint' : 'lightboxHintSingle')}
          </DialogDescription>
          <div className="bg-muted flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md">
            {file.src === null ? (
              <p role="status" className="text-muted-foreground p-8 text-sm">
                {t('loading', { name: file.filename })}
              </p>
            ) : file.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element -- a signed link on the bucket host: next/image would need it configured
              <img
                src={file.src}
                alt={file.filename}
                referrerPolicy="no-referrer"
                className="max-h-[70dvh] max-w-full object-contain"
              />
            ) : (
              <video
                src={file.src}
                controls
                preload="metadata"
                className="max-h-[70dvh] max-w-full"
                aria-label={file.filename}
              />
            )}
          </div>
          {position === undefined || position.total < 2 ? null : (
            // A polite status: the arrows change the picture, and a screen reader hears which one it is now
            <p
              aria-live="polite"
              aria-atomic="true"
              className="text-muted-foreground text-center text-xs"
            >
              {t('position', { current: position.index + 1, total: position.total })}
            </p>
          )}
          {caption === undefined || caption === null ? null : (
            <p className="text-sm break-words whitespace-pre-wrap">
              {position === undefined || position.total < 2 ? null : (
                <span className="mr-1 font-medium">{position.number}.</span>
              )}
              {caption}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {onPrevious === undefined ? null : (
              <Button variant="outline" size="icon" onClick={onPrevious} aria-label={t('previous')}>
                <ChevronLeft aria-hidden />
              </Button>
            )}
            {onNext === undefined ? null : (
              <Button variant="outline" size="icon" onClick={onNext} aria-label={t('next')}>
                <ChevronRight aria-hidden />
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <a
                href={file.downloadUrl}
                download={file.filename}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download aria-hidden />
                {t('download')}
              </a>
            </Button>
            <DialogClose asChild>
              <Button
                variant="secondary"
                size="sm"
                title={t('closeWithKey')}
                aria-keyshortcuts="Escape"
              >
                {t('close')}
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
