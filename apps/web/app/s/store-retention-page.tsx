'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { RetentionPanel } from '../../components/settings/retention-panel'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useRetention } from '../../lib/settings/use-integrations'

// Settings → Store → Data retention (TDD_09 §13). The api asks settings:manage_retention to read the windows as well as to
// change them: shortening one deletes data the night after.
export function StoreRetentionPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_MANAGE_RETENTION) ? (
    <RetentionLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_MANAGE_RETENTION} />
  )
}

function RetentionLoader(): ReactElement {
  const t = useTranslations('settings.retention')
  const { storeId } = useStore()
  const retention = useRetention(storeId)
  if (retention.isError) {
    return <LoadFailed error={retention.error} onRetry={() => void retention.refetch()} />
  }
  if (retention.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </header>
      {/* A fresh form per store: nothing typed for one store carries to the next */}
      <RetentionPanel key={storeId} saved={retention.data} />
    </section>
  )
}
