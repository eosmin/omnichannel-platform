'use client'

import { Puzzle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { type DestructiveAction, ShippingPlugin } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useDestructiveAction } from '../../components/shared/destructive-action'
import { Button } from '../../components/ui/button'
import type { PluginCatalogEntryView } from '../../lib/settings/channels-requests'
import {
  useInstallPlugin,
  usePluginCatalog,
  useUninstallPlugin
} from '../../lib/settings/use-channels'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// Uninstalling disconnects every account of the plugin, which is the high tier of a disconnect
const UNINSTALL_ACTION: DestructiveAction = 'DISCONNECT_CHANNEL'

// Settings → Store → Plugins (TDD_09 §13, D19): the catalog of plugins this store may install, and
// install and uninstall per store. Registering a remote plugin by its manifest is Step 5.6.
export function StorePluginsPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_VIEW) ? (
    <PluginsLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_VIEW} />
  )
}

function PluginsLoader(): ReactElement {
  const { storeId } = useStore()
  const catalog = usePluginCatalog(storeId)
  if (catalog.isError)
    return <LoadFailed error={catalog.error} onRetry={() => void catalog.refetch()} />
  if (catalog.data === undefined) return <PageLoading />
  return <PluginsBody entries={catalog.data} />
}

function PluginsBody({ entries }: { entries: PluginCatalogEntryView[] }): ReactElement {
  const t = useTranslations('settings.plugins')
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Puzzle aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {entries.map(entry => (
            <PluginRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  )
}

function PluginRow({ entry }: { entry: PluginCatalogEntryView }): ReactElement {
  const t = useTranslations('settings.plugins')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const install = useInstallPlugin(storeId)
  const uninstall = useUninstallPlugin(storeId)
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_PLUGINS)
  // A channel plugin and the shipping entry can be installed; the others are registered in Step 5.6
  const isShipping = entry.id === ShippingPlugin.ID
  const installable = entry.channel !== null || isShipping

  const askToUninstall = (): void => {
    const installationId = entry.installationId
    if (installationId === null) return
    run(UNINSTALL_ACTION, {
      title: t('uninstall.title', { name: entry.name }),
      description: isShipping
        ? t('uninstall.descriptionShipping', {
            count: entry.activeConnections,
            shipments: entry.openShipments,
            pickups: entry.openPickups
          })
        : t('uninstall.description', { count: entry.activeConnections }),
      confirmLabel: t('uninstall.confirm'),
      onConfirm: async () => {
        try {
          await uninstall.mutateAsync(installationId)
          toast.success(t('uninstall.done', { name: entry.name }))
        } catch (error) {
          toast.error(errorText(error))
        }
      }
    })
  }

  const doInstall = (): void => {
    install.mutate(entry.id, {
      onSuccess: () =>
        toast.success(t(isShipping ? 'install.doneCarrier' : 'install.done', { name: entry.name })),
      onError: error => toast.error(errorText(error))
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium">{entry.name}</h2>
        <span className="text-muted-foreground text-sm">
          {entry.isOfficial ? t('official') : t('by', { author: entry.authorName })}
          {entry.installed ? ` · ${t('installed')}` : ''}
          {entry.installed && entry.activeConnections > 0
            ? ` · ${t('connections', { count: entry.activeConnections })}`
            : ''}
        </span>
      </div>
      {canManage ? (
        entry.installed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uninstall.isPending}
            onClick={askToUninstall}
          >
            {t('uninstall.action')}
            <span className="sr-only"> {entry.name}</span>
          </Button>
        ) : installable ? (
          <Button
            type="button"
            size="sm"
            disabled={install.isPending}
            busy={install.isPending}
            onClick={doInstall}
          >
            {t('install.action')}
            <span className="sr-only"> {entry.name}</span>
          </Button>
        ) : (
          <span className="text-muted-foreground text-sm">{t('comingLater')}</span>
        )
      ) : null}
    </li>
  )
}
