'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Permissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { SnippetsPanel } from '../../components/settings/snippets-panel'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useStoreSnippets } from '../../lib/settings/use-content'

// Settings → Store → Snippets (TDD_09 §13): the saved replies. Reading needs CONVERSATIONS_VIEW and
// changing them SETTINGS_EDIT, as the api asks. There is no "approved for AI" choice: the MVP has no AI.
export function StoreSnippetsPage(): ReactElement {
  const { can } = useStore()
  return can(Permissions.CONVERSATIONS_VIEW) ? <SnippetsLoader /> : <PermissionDenied />
}

function SnippetsLoader(): ReactElement {
  const t = useTranslations('settings.snippets')
  const { storeId } = useStore()
  const snippets = useStoreSnippets(storeId)
  if (snippets.isError) {
    return <LoadFailed error={snippets.error} onRetry={() => void snippets.refetch()} />
  }
  if (snippets.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </header>
      <SnippetsPanel snippets={snippets.data} />
    </section>
  )
}
