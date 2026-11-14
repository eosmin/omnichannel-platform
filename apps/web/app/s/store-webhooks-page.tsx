'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { WebhooksPanel } from '../../components/settings/webhooks-panel'
import { useWebhooks } from '../../lib/settings/use-integrations'

// Settings → Store → Webhooks (TDD_09 §13). The api asks settings:manage_webhooks for everything, the list included: a webhook
// sends the events of the store to an address of the owner's choosing.
export function StoreWebhooksPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_MANAGE_WEBHOOKS) ? (
    <WebhooksLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_MANAGE_WEBHOOKS} />
  )
}

function WebhooksLoader(): ReactElement {
  const t = useTranslations('settings.webhooks')
  const { storeId } = useStore()
  const webhooks = useWebhooks(storeId)
  // A failed refetch with the list in hand keeps the page: a panel that unmounts takes the secret it just made with it
  if (webhooks.data === undefined) {
    return webhooks.isError ? (
      <LoadFailed error={webhooks.error} onRetry={() => void webhooks.refetch()} />
    ) : (
      <PageLoading />
    )
  }
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </header>
      <WebhooksPanel webhooks={webhooks.data} />
    </section>
  )
}
