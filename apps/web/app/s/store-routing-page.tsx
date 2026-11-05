'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Permissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { RoutingPanel } from '../../components/settings/routing-panel'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useMemberChoices, useRules, useTagChoices } from '../../lib/settings/use-routing'

// Settings → Store → Routing (TDD_09 §13). Opening it needs SETTINGS_VIEW, which is what the api asks
// for the rules. The people and tags a rule points at come from lists that need CONVERSATIONS_VIEW: a
// person without it still sees the rules, with those names left out.
export function StoreRoutingPage(): ReactElement {
  const { can } = useStore()
  return can(Permissions.SETTINGS_VIEW) ? (
    <RoutingLoader />
  ) : (
    <PermissionDenied permission={Permissions.SETTINGS_VIEW} />
  )
}

function RoutingLoader(): ReactElement {
  const t = useTranslations('settings.routing')
  const { storeId, can } = useStore()
  const mayList = can(Permissions.CONVERSATIONS_VIEW)
  const rules = useRules(storeId)
  const members = useMemberChoices(storeId, mayList)
  const tags = useTagChoices(storeId, mayList)
  const queries = [rules, members, tags]
  const failed = queries.find(query => query.isError)
  if (failed !== undefined) {
    return (
      <LoadFailed
        error={failed.error}
        onRetry={() => {
          for (const query of queries) if (query.isError) void query.refetch()
        }}
      />
    )
  }
  if (
    rules.data === undefined ||
    (mayList && (members.data === undefined || tags.data === undefined))
  ) {
    return <PageLoading />
  }
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
      </header>
      <RoutingPanel rules={rules.data} members={members.data ?? []} tags={tags.data ?? []} />
    </section>
  )
}
