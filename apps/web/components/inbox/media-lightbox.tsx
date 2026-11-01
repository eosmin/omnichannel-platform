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
}

// A file at full size over the thread. Radix gives it the focus trap, Escape and the return of the
// focus to the thumbnail that opened it.
export function MediaLightbox({
  file,
  onClose,
  onPrevious,
  onNext
}: {
  file: LightboxFile | null
  onClose: () => void
  // The gallery walks its files with the arrows; the thread opens one file and passes neither
  onPrevious?: () => void
  onNext?: () => void
}): ReactElement {
  const t = useTranslations('inbox.thread.media')
  return (
    <Dialog open={file !== null} onOpenChange={open => (open ? undefined : onClose())}>
      {file === null ? null : (
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] flex-col gap-3 p-4 sm:max-w-4xl"
          onKeyDown={event => {
            // A video keeps the arrows for its own seek bar
            if (event.target instanceof HTMLVideoElement) return
            if (event.key === 'ArrowLeft' && onPrevious !== undefined) onPrevious()
            if (event.key === 'ArrowRight' && onNext !== undefined) onNext()
          }}
        >
          <DialogTitle className="truncate pr-8 text-base">{file.filename}</DialogTitle>
          <DialogDescription className="sr-only">{t('lightboxDescription')}</DialogDescription>
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
              <Button variant="secondary" size="sm">
                {t('close')}
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
