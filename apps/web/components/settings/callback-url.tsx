'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { CopyButton } from './copy-button'

// For a channel the provider calls: the address the owner pastes into the provider's dashboard. It
// carries no secret (the verify token of Meta is one value for the app, in the environment).
export function CallbackUrl({ url }: { url: string }): ReactElement {
  const t = useTranslations('settings.channels')
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{t('callbackUrl.label')}</span>
      <div className="flex items-center gap-2">
        <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-xs">
          {url}
        </code>
        <CopyButton text={url} label={t('callbackUrl.label')} />
      </div>
      <p className="text-muted-foreground text-xs">{t('callbackUrl.hint')}</p>
    </div>
  )
}
