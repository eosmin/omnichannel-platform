'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import type { MessageView } from '@platform/api-client'

import type { AlbumCaptionLine } from '../../lib/inbox/file-caption'
import { cn } from '../../lib/utils'

import { FileCaption } from './file-caption'

type MediaFile = MessageView['media'][number]

// The same small round number is drawn on a picture and in front of its text, so the eye can match them
const NUMBER_CLASS =
  'bg-background text-foreground flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] leading-none font-semibold tabular-nums'

// The mark on the corner of a picture whose text is in the list under the album. Read aloud too: the number is
// what ties the picture to its text.
export function AlbumCaptionMark({ number }: { number: number }): ReactElement {
  return (
    <span
      data-testid="album-caption-mark"
      className={cn(NUMBER_CLASS, 'pointer-events-none absolute top-1 left-1 shadow-sm')}
    >
      {number}
    </span>
  )
}

// The texts of a reply with several pictures, one line per picture that has something to say, in the order of the
// pictures (the first one first) and each with its number. A picture with no text has no line. The first picture's
// line is the text of the message (`lead`, drawn by the thread as it draws any text); the others are the text
// under their file.
export function AlbumCaptionList({
  lines,
  lead
}: {
  lines: readonly AlbumCaptionLine<MediaFile>[]
  lead: ReactNode
}): ReactElement {
  const t = useTranslations('inbox.thread')
  return (
    <ol role="list" aria-label={t('albumCaptions')} className="flex list-none flex-col gap-1.5">
      {lines.map(line => (
        <li key={line.file.id} value={line.number} className="flex items-start gap-1.5">
          <span
            aria-hidden
            data-testid="album-caption-number"
            className={cn(NUMBER_CLASS, 'mt-px')}
          >
            {line.number}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {line.isLead ? lead : <FileCaption file={line.file} />}
          </div>
        </li>
      ))}
    </ol>
  )
}
