'use client'

import { Clock } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { MessageType } from '@platform/core/domain'

import type { PendingMessage } from '../../lib/realtime/offline-queue'
import { cn } from '../../lib/utils'

// A message the agent wrote that the api does not have yet (the connection is down, or the request is
// on its way): drawn where it will be, with the clock. The stored message replaces it when it arrives.
export function PendingBubble({ message }: { message: PendingMessage }): ReactElement {
  const t = useTranslations('inbox.thread')
  const format = useFormatter()
  const isNote = message.type === MessageType.INTERNAL_NOTE
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-1 rounded-lg px-3 py-2 text-sm opacity-80 md:max-w-[70%]',
          !isNote && 'bg-secondary text-secondary-foreground',
          isNote && 'bg-note text-note-foreground border-note-border border border-dashed'
        )}
      >
        {isNote ? <p className="text-xs font-semibold">{t('internalNote')}</p> : null}
        <p className="break-words whitespace-pre-wrap">{message.content}</p>
        <p className="text-muted-foreground flex items-center justify-end gap-1.5 text-xs">
          <time dateTime={message.createdAt}>
            {format.dateTime(new Date(message.createdAt), { timeStyle: 'short' })}
          </time>
          <span className="inline-flex items-center">
            <Clock aria-hidden className="size-3.5" />
            <span className="sr-only">{t('ticks.queued')}</span>
          </span>
        </p>
      </div>
    </div>
  )
}
