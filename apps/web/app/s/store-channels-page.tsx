'use client'

import { Plug } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { ChannelConnectionListStates } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { ConnectDialog } from '../../components/settings/connect-dialog'
import { ConnectionCard } from '../../components/settings/connection-card'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import type {
  ChannelConnectionView,
  PluginCatalogEntryView
} from '../../lib/settings/channels-requests'
import { useConnections, usePluginCatalog } from '../../lib/settings/use-channels'

// Settings → Store → Channels (TDD_09 §13, TDD_10 §10): the accounts of the store with their health,
// connect, test and disconnect. It is drawn from the manifest of each plugin, so a channel that a
// plugin adds needs no change here. The inbox sends the owner here when it has nothing to show.
export function StoreChannelsPage(): ReactElement {
  const { can } = useStore()
  return can(Permissions.SETTINGS_VIEW) ? <ChannelsLoader /> : <PermissionDenied />
}

function ChannelsLoader(): ReactElement {
  const { storeId } = useStore()
  const live = useConnections(storeId, ChannelConnectionListStates.LIVE)
  const catalog = usePluginCatalog(storeId)
  if (live.isError && live.data === undefined) {
    return <LoadFailed error={live.error} onRetry={() => void live.refetch()} />
  }
  if (live.data === undefined) return <PageLoading />
  return (
    <ChannelsBody
      live={live.data.pages.flatMap(page => page.data)}
      hasMoreLive={live.hasNextPage}
      loadingMoreLive={live.isFetchingNextPage}
      loadMoreLiveFailed={live.isFetchNextPageError}
      onLoadMoreLive={() => void live.fetchNextPage()}
      catalog={catalog.data}
      catalogFailed={catalog.isError}
    />
  )
}

function ChannelsBody({
  live,
  hasMoreLive,
  loadingMoreLive,
  loadMoreLiveFailed,
  onLoadMoreLive,
  catalog,
  catalogFailed
}: {
  live: ChannelConnectionView[]
  hasMoreLive: boolean
  loadingMoreLive: boolean
  loadMoreLiveFailed: boolean
  onLoadMoreLive: () => void
  catalog: PluginCatalogEntryView[] | undefined
  catalogFailed: boolean
}): ReactElement {
  const t = useTranslations('settings.channels')
  const { storeId, can } = useStore()
  const [connecting, setConnecting] = useState<PluginCatalogEntryView | null>(null)
  const canEdit = can(Permissions.SETTINGS_EDIT)
  const pluginOf = (id: string): PluginCatalogEntryView | undefined =>
    catalog?.find(entry => entry.id === id)
  // A channel can be connected once it is installed in the store (Settings → Plugins)
  const connectable = (catalog ?? []).filter(entry => entry.installed && entry.channel !== null)

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>

      {/* Before the list: with hundreds of accounts it would sit below all of them */}
      <section aria-labelledby="add-channel" className="flex flex-col gap-3">
        <h2 id="add-channel" className="text-lg font-semibold">
          {t('add.title')}
        </h2>
        {catalogFailed ? (
          <p role="alert" className="text-destructive text-sm">
            {t('add.catalogFailed')}
          </p>
        ) : catalog === undefined ? (
          <PageLoading />
        ) : connectable.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('add.nonInstalled')}{' '}
            <Link
              className="underline"
              href={AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS)}
            >
              {t('add.goToPlugins')}
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connectable.map(entry => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <span className="font-medium">{entry.name}</span>
                {canEdit ? (
                  <Button type="button" size="sm" onClick={() => setConnecting(entry)}>
                    {t('add.connect')}
                    <span className="sr-only"> {entry.name}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {live.length === 0 && !hasMoreLive ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Plug aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {live.map(connection => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              plugin={pluginOf(connection.pluginId)}
            />
          ))}
        </ul>
      )}
      {loadMoreLiveFailed ? (
        <p role="alert" className="text-destructive text-sm">
          {t('loadMoreFailed')}
        </p>
      ) : null}
      {hasMoreLive ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={loadingMoreLive}
          onClick={onLoadMoreLive}
        >
          {t('loadMore')}
        </Button>
      ) : null}

      <PastChannels pluginOf={pluginOf} />

      {connecting === null ? null : (
        <ConnectDialog plugin={connecting} onClose={() => setConnecting(null)} />
      )}
    </section>
  )
}

// The disconnected accounts are read when the person asks for them: most stores never look
function PastChannels({
  pluginOf
}: {
  pluginOf: (id: string) => PluginCatalogEntryView | undefined
}): ReactElement {
  const t = useTranslations('settings.channels')
  const { storeId } = useStore()
  const [shown, setShown] = useState(false)
  const past = useConnections(storeId, ChannelConnectionListStates.PAST, shown)
  const rows = past.data?.pages.flatMap(page => page.data) ?? []

  return (
    <section aria-labelledby="past-channels" className="flex flex-col gap-3">
      <h2 id="past-channels" className="text-lg font-semibold">
        {t('past.title')}
      </h2>
      {shown ? (
        <>
          <p className="text-muted-foreground text-sm">{t('past.hint')}</p>
          {past.isError && past.data === undefined ? (
            <LoadFailed error={past.error} onRetry={() => void past.refetch()} />
          ) : past.data === undefined ? (
            <PageLoading />
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('past.none')}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {rows.map(connection => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  plugin={pluginOf(connection.pluginId)}
                />
              ))}
            </ul>
          )}
          {past.isFetchNextPageError ? (
            <p role="alert" className="text-destructive text-sm">
              {t('loadMoreFailed')}
            </p>
          ) : null}
          {past.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={past.isFetchingNextPage}
              onClick={() => void past.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          ) : null}
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setShown(true)}
        >
          {t('past.show')}
        </Button>
      )}
    </section>
  )
}
