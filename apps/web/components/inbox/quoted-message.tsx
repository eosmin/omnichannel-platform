'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'

import { cn } from '../../lib/utils'

type Quote = NonNullable<MessageView['replyTo']>

const KNOWN_TYPES = [
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'DOCUMENT',
  'LOCATION',
  'PRODUCT_CARD',
  'ORDER_SUMMARY',
  'TEMPLATE',
  'INTERNAL_NOTE'
] as const
const typeKeyOf = (type: string): (typeof KNOWN_TYPES)[number] | 'unknown' =>
  KNOWN_TYPES.find(known => known === type) ?? 'unknown'

// The message a reply answers, above the text: who wrote it and the start of what it said, or its type
// when it had no text. A click scrolls to the original while it is in the loaded part of the thread; an
// original that was deleted, or that lies outside the conversation, is a neutral line.
export function QuotedMessage({
  quote,
  replyTo,
  authorName,
  onJump
}: {
  // null when the original lies outside the conversation or is a note the reader may not see
  quote: Quote | null
  replyTo: string
  authorName: string | null
  // undefined when the original is not in the loaded part of the thread
  onJump: ((messageId: string) => void) | undefined
}): ReactElement {
  const t = useTranslations('inbox.thread.quote')
  const body =
    quote === null ? (
      <span className="text-muted-foreground italic">{t('unavailable')}</span>
    ) : quote.deleted ? (
      <span className="text-muted-foreground italic">{t('deleted')}</span>
    ) : (
      <span className="line-clamp-2 break-words">
        {quote.content === null || quote.content === ''
          ? t(`type.${typeKeyOf(quote.type)}`)
          : quote.content}
      </span>
    )
  const classes = cn(
    'border-foreground/30 flex w-full flex-col gap-0.5 rounded-sm border-l-2 bg-black/5 px-2 py-1 text-left text-xs dark:bg-white/10'
  )
  const content = (
    <>
      {authorName === null ? null : (
        <span className="font-medium">{t('label', { author: authorName })}</span>
      )}
      {body}
    </>
  )
  if (quote === null || quote.deleted || onJump === undefined) {
    return <div className={classes}>{content}</div>
  }
  return (
    <button
      type="button"
      className={cn(classes, 'focus-visible:ring-ring outline-none focus-visible:ring-2')}
      onClick={() => onJump(replyTo)}
    >
      {content}
    </button>
  )
}
