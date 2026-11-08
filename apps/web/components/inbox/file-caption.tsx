'use client'

import { TriangleAlert } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'

import { fileCaptionOf, mayResendFileCaption } from '../../lib/inbox/file-caption'

type MediaFile = MessageView['media'][number]

// The action to send a text again and its confirmation, downloaded the first time a text needs them
const FileCaptionResend = dynamic(() => import('./file-caption-resend'), { ssr: false })

const NOTICE_KEYS = {
  failed: 'fileCaptionFailed',
  unconfirmed: 'fileCaptionUnconfirmed',
  queued: 'fileCaptionQueued'
} as const

// The text under one file of a message with several (text of an agent: React escapes it) and, when the
// channel sent it as a message of its own and it did not clearly go, what happened to it.
export function FileCaption({
  file,
  messageId,
  conversationId,
  canResend
}: {
  file: MediaFile
  messageId: string
  conversationId: string
  // The agent may send a text again (the api checks it again)
  canResend: boolean
}): ReactElement | null {
  const t = useTranslations('inbox.thread')
  const caption = fileCaptionOf(file)
  if (caption === null) return null
  return (
    <div className="flex flex-col gap-0.5">
      {caption.text === null ? null : (
        <p className="text-sm break-words whitespace-pre-wrap">{caption.text}</p>
      )}
      {caption.state === null ? null : (
        <p role="status" className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          {t(NOTICE_KEYS[caption.state])}
        </p>
      )}
      {canResend && mayResendFileCaption(caption.state, file.delivery) ? (
        <div>
          <FileCaptionResend
            conversationId={conversationId}
            messageId={messageId}
            mediaId={file.id}
            state={caption.state}
          />
        </div>
      ) : null}
    </div>
  )
}
