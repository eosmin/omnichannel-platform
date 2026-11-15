'use client'

import { Boxes } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { CarrierConnectionView } from '@platform/api-client'

import { CarrierGuidePanel } from './carrier-guide-panel'

// Settings → Carriers → Guide balance (TDD_17 §4.18): one panel per live connection. The section is offered only to who holds
// carriers:view_guide_balance (the panel above checks it), so every read here is allowed.
export function CarrierGuidesSection({
  connections
}: {
  connections: readonly CarrierConnectionView[]
}): ReactElement {
  const t = useTranslations('settings.carriers.guides')
  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
        <Boxes aria-hidden className="text-muted-foreground size-8" />
        <p className="text-muted-foreground max-w-sm text-sm">{t('empty')}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{t('intro')}</p>
      <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
        {connections.map(connection => (
          <CarrierGuidePanel key={connection.id} connection={connection} />
        ))}
      </ul>
    </div>
  )
}
