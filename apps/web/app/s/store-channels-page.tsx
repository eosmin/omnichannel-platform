'use client'

import { Plug } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { ChannelConnectionListStates } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { ConnectDialog } from '../../components/settings/connect-dialog'
import { ConnectionCard } from '../../components/settings/connection-card'
import { OAuthAssetDialog } from '../../components/settings/oauth-asset-dialog'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { UpdateTokenDialog } from '../../components/settings/update-token-dialog'
import { Button } from '../../components/ui/button'
import type {
  ChannelConnectionView,
  PluginCatalogEntryView
} from '../../lib/settings/channels-requests'
import { OAUTH_GENERIC_FAILURE, type OAuthReturnFailure } from '../../lib/settings/oauth-return'
import { useConnections, usePluginCatalog } from '../../lib/settings/use-channels'
import { useOAuthReturn } from '../../lib/settings/use-oauth-return'

type LoginReturn = ReturnType<typeof useOAuthReturn>

// Settings → Store → Channels (TDD_09 §13, TDD_10 §10): the accounts of the store with their health,
// connect, test and disconnect. It is drawn from the manifest of each plugin, so a channel that a
// plugin adds needs no change here. The inbox sends the owner here when it has nothing to show.
export function StoreChannelsPage(): ReactElement {
  const { can } = useStore()
  // What Facebook sent the person back with is read here, before anything that can keep the page from drawing
  // (no permission, a list that loads or fails): the id of the session must leave the address in every case
  const login = useOAuthReturn()
  const canEdit = can(Permissions.SETTINGS_EDIT)
  const { session, clear } = login
  // Without the right to connect there is nothing to pick a Page for: the id is let go (the session expires)
  useEffect(() => {
    if (session !== null && !canEdit) clear()
  }, [session, canEdit, clear])
  return can(Permissions.SETTINGS_VIEW) ? (
    <ChannelsLoader login={login} />
  ) : (
    <PermissionDenied permission={Permissions.SETTINGS_VIEW} />
  )
}

function ChannelsLoader({ login }: { login: LoginReturn }): ReactElement {
  const { storeId } = useStore()
  const live = useConnections(storeId, ChannelConnectionListStates.LIVE)
  const catalog = usePluginCatalog(storeId)
  if (live.isError && live.data === undefined) {
    return <LoadFailed error={live.error} onRetry={() => void live.refetch()} />
  }
  if (live.data === undefined) return <PageLoading />
  return (
    <ChannelsBody
      login={login}
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
  login,
  live,
  hasMoreLive,
  loadingMoreLive,
  loadMoreLiveFailed,
  onLoadMoreLive,
  catalog,
  catalogFailed
}: {
  login: LoginReturn
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
  const [updating, setUpdating] = useState<{
    connection: ChannelConnectionView
    plugin: PluginCatalogEntryView
  } | null>(null)
  const canEdit = can(Permissions.SETTINGS_EDIT)
  // Where the focus goes when the dialog of the Pages closes or the notice is dismissed: both leave it on
  // nothing, because neither was opened from a control
  const heading = useRef<HTMLHeadingElement>(null)
  const focusHeading = (): void => {
    setTimeout(() => heading.current?.focus(), 0)
  }
  const pluginOf = (id: string): PluginCatalogEntryView | undefined =>
    catalog?.find(entry => entry.id === id)
  // A channel can be connected once it is installed in the store (Settings → Plugins)
  const connectable = (catalog ?? []).filter(entry => entry.installed && entry.channel !== null)

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          {t('title')}
        </h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>

      {login.failure === null ? null : (
        <LoginFailed
          failure={login.failure}
          onDismiss={() => {
            login.clear()
            focusHeading()
          }}
        />
      )}

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
              onUpdateToken={(target, targetPlugin) =>
                setUpdating({ connection: target, plugin: targetPlugin })
              }
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

      {updating === null ? null : (
        <UpdateTokenDialog
          connection={updating.connection}
          plugin={updating.plugin}
          onClose={() => setUpdating(null)}
        />
      )}
      {connecting === null ? null : (
        <ConnectDialog plugin={connecting} onClose={() => setConnecting(null)} />
      )}
      {login.session === null || !canEdit ? null : (
        <OAuthAssetDialog
          sessionId={login.session}
          onClose={() => {
            login.clear()
            focusHeading()
          }}
        />
      )}
    </section>
  )
}

// Why a login with Facebook ended with nothing to connect: the text of a reason of the closed list, or the
// generic one. The reason is mapped by a table and never painted as it came.
function LoginFailed({
  failure,
  onDismiss
}: {
  failure: OAuthReturnFailure
  onDismiss: () => void
}): ReactElement {
  const t = useTranslations('settings.channels')
  const tReason = useTranslations('settings.channels.connectFailure')
  return (
    <div
      role="alert"
      className="border-destructive/40 flex flex-wrap items-start gap-3 rounded-lg border p-3 text-sm"
    >
      <p className="min-w-0 flex-1">
        {failure === OAUTH_GENERIC_FAILURE ? t('oauth.failedGeneric') : tReason(failure)}
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
        {t('oauth.dismiss')}
      </Button>
    </div>
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
