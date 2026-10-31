'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

// What the centre of the inbox shows while the chunk of the open conversation arrives
export function ConversationPaneLoading(): ReactElement {
  const t = useTranslations('common')
  return (
    <p role="status" className="text-muted-foreground p-4 text-sm">
      {t('loading')}
    </p>
  )
}
