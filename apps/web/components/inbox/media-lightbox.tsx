'use client'

import { Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Button } from '../ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

export interface LightboxFile {
  kind: 'image' | 'video'
  // What is shown: the large variant of an image, the file itself for a video
  src: string
  // The original, to download
  downloadUrl: string
  filename: string
}

// A file at full size over the thread. Radix gives it the focus trap, Escape and the return of the
// focus to the thumbnail that opened it.
export function MediaLightbox({
  file,
  onClose
}: {
  file: LightboxFile | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('inbox.thread.media')
  return (
    <Dialog open={file !== null} onOpenChange={open => (open ? undefined : onClose())}>
      {file === null ? null : (
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] flex-col gap-3 p-4 sm:max-w-4xl">
          <DialogTitle className="truncate pr-8 text-base">{file.filename}</DialogTitle>
          <DialogDescription className="sr-only">{t('lightboxDescription')}</DialogDescription>
          <div className="bg-muted flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md">
            {file.kind === 'image' ? (
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
