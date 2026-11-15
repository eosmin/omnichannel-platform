'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { SafetyPanel } from '../../components/settings/safety-panel'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useSafety } from '../../lib/settings/use-safety'

// Settings → Store → Safety and confirmations (TDD_09 §11.2, §13). The api answers the settings to whoever may see
// conversations, because every screen asks them; changing them takes settings:edit, which the panel asks for its controls.
export function StoreSafetyPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_VIEW) && can(ClientPermissions.CONVERSATIONS_VIEW) ? (
    <SafetyLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_VIEW} />
  )
}

function SafetyLoader(): ReactElement {
  const t = useTranslations('settings.safety')
  const { storeId } = useStore()
  const safety = useSafety(storeId)
  if (safety.isError) {
    return <LoadFailed error={safety.error} onRetry={() => void safety.refetch()} />
  }
  if (safety.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </header>
      {/* A fresh form per store: nothing chosen for one store carries to the next */}
      <SafetyPanel key={storeId} saved={safety.data} />
    </section>
  )
}
