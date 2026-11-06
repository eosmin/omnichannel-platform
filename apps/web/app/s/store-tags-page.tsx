'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { TagsPanel } from '../../components/settings/tags-panel'
import { useStoreTags } from '../../lib/settings/use-content'

// Settings → Store → Tags (TDD_09 §13). The api lets whoever may see conversations read the tags, and
// SETTINGS_EDIT change them; the panel draws its actions only for who holds that.
export function StoreTagsPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.CONVERSATIONS_VIEW) ? (
    <TagsLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.CONVERSATIONS_VIEW} />
  )
}

function TagsLoader(): ReactElement {
  const t = useTranslations('settings.tags')
  const { storeId } = useStore()
  const tags = useStoreTags(storeId)
  if (tags.isError) return <LoadFailed error={tags.error} onRetry={() => void tags.refetch()} />
  if (tags.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </header>
      <TagsPanel tags={tags.data} />
    </section>
  )
}
