'use client'

import { ExternalLink } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { hostOf } from '../../lib/inbox/link-host'

// What the customer shared on Instagram or Messenger: an untrusted link. Its host is shown, it opens
// in a tab of its own without the address of the inbox, and the server never fetched it. A story
// mention is a signed link that stops working within about a day, hence the note.
export function SharedLink({ url }: { url: string }): ReactElement | null {
  const t = useTranslations('inbox.thread.sharedLink')
  const host = hostOf(url)
  if (host === null) return null
  return (
    <div className="flex flex-col gap-0.5">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="focus-visible:ring-ring flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2"
      >
        <ExternalLink aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground block">{t('label')}</span>
          <span className="sr-only">{t('open', { host })}</span>
          <span aria-hidden>{host}</span>
        </span>
      </a>
      <p className="text-muted-foreground text-xs">{t('expiresNote')}</p>
    </div>
  )
}
