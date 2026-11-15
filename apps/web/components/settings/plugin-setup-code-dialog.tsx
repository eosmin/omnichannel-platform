'use client'

import { ExternalLink } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { PluginSetupOfferView } from '../../lib/settings/plugins-requests'

import { SecretOnceDialog } from './secret-once-dialog'

// The one-time code of an installation that waits for its plugin (TDD_10 §6.3): shown once, with when it expires and where the plugin
// has its settings page, which is where the owner pastes it. The plugin trades it for its key; the platform never shows the key.
export function PluginSetupCodeDialog({
  offer,
  name,
  onClose
}: {
  offer: PluginSetupOfferView
  name: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.plugins.setupCode')
  const format = useFormatter()
  return (
    <SecretOnceDialog
      title={t('title', { name })}
      description={t('description', {
        time: format.dateTime(new Date(offer.expiresAt), { timeStyle: 'short', dateStyle: 'short' })
      })}
      label={t('label')}
      secret={offer.code}
      testId="plugin-setup-code"
      onClose={onClose}
    >
      <p className="text-muted-foreground text-sm">{t('how')}</p>
      {offer.settingsUrl === null ? null : (
        <a
          href={offer.settingsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm underline underline-offset-2"
        >
          {t('openSettings', { name })}
          <ExternalLink aria-hidden className="size-3.5" />
        </a>
      )}
    </SecretOnceDialog>
  )
}
