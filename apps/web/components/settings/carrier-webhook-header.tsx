'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { CARRIER_WEBHOOK_SECRET_HEADER } from '@platform/core/domain'

import { CopyButton } from './copy-button'

// The name of the header the carrier sends the secret in, to paste next to the notice address in the portal of the carrier
// (TDD_17 §4.9: a carrier that signs nothing proves the call is ours with the secret itself). Never the secret.
export function CarrierWebhookHeader({ small = false }: { small?: boolean }): ReactElement {
  const t = useTranslations('settings.carriers.webhook')
  return (
    <div className="flex flex-col gap-1">
      <span className={small ? 'text-xs font-medium' : 'text-sm font-medium'}>
        {t('headerLabel')}
      </span>
      <div className="flex items-center gap-2">
        <code
          data-testid="carrier-webhook-header"
          className={`bg-muted min-w-0 flex-1 rounded-md px-2 py-1 font-mono break-all ${small ? 'text-xs' : 'text-sm'}`}
        >
          {CARRIER_WEBHOOK_SECRET_HEADER}
        </code>
        <CopyButton text={CARRIER_WEBHOOK_SECRET_HEADER} label={t('headerLabel')} />
      </div>
    </div>
  )
}
