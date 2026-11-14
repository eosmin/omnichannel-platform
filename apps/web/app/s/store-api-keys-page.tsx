'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { ApiKeysPanel } from '../../components/settings/api-keys-panel'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useApiKeys } from '../../lib/settings/use-integrations'

// Settings → Store → API keys (TDD_09 §13). The api asks settings:manage_api_keys for everything, the list included: a key is a
// credential.
export function StoreApiKeysPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_MANAGE_API_KEYS) ? (
    <ApiKeysLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_MANAGE_API_KEYS} />
  )
}

function ApiKeysLoader(): ReactElement {
  const t = useTranslations('settings.apiKeys')
  const { storeId } = useStore()
  const keys = useApiKeys(storeId)
  // A failed refetch with the list in hand keeps the page: a panel that unmounts takes the key it just made with it
  if (keys.data === undefined) {
    return keys.isError ? (
      <LoadFailed error={keys.error} onRetry={() => void keys.refetch()} />
    ) : (
      <PageLoading />
    )
  }
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </header>
      <ApiKeysPanel keys={keys.data} />
    </section>
  )
}
