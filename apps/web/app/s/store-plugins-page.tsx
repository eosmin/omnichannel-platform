'use client'

import { Plus, Puzzle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import {
  type DestructiveAction,
  PLUGIN_REVOKE_CONFIRMATION,
  PluginCatalogTypes,
  PluginInstallationStatus,
  ShippingPlugin
} from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { PluginDetailDialog } from '../../components/settings/plugin-detail-dialog'
import { PluginInstallDialog } from '../../components/settings/plugin-install-dialog'
import { PluginRegisterDialog } from '../../components/settings/plugin-register-dialog'
import { PluginWidgetsPanel } from '../../components/settings/plugin-widgets-panel'
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
// Revoking an integration plugin takes its key away and cannot be undone: the critical tier, with the word typed (TDD_10 §6.6)
const REVOKE_ACTION: DestructiveAction = 'REVOKE_ALL_PLUGIN_ACCESS'

// Settings → Store → Plugins (TDD_09 §13, D19): the catalog of plugins this store may install, and
// install and uninstall per store, and (Step 5.6 PR W1) registering a plugin of the organization by its manifest, the consent screen of an
// integration plugin, its detail and its revocation.
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
  const { can } = useStore()
  const [registering, setRegistering] = useState(false)
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {can(ClientPermissions.SETTINGS_MANAGE_PLUGINS) ? (
          <Button type="button" size="sm" onClick={() => setRegistering(true)}>
            <Plus aria-hidden />
            {t('register.action')}
          </Button>
        ) : null}
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
      <PluginWidgetsPanel />
      {registering ? <PluginRegisterDialog onClose={() => setRegistering(false)} /> : null}
    </section>
  )
}

// A plugin that runs outside the platform (an integration, or a channel an organization registered) is installed through the consent
// screen and is revoked with the word typed; the official channels and the shipping entry take the plain install
function needsConsent(entry: PluginCatalogEntryView): boolean {
  return (
    entry.type === String(PluginCatalogTypes.INTEGRATION) ||
    (entry.type === String(PluginCatalogTypes.CHANNEL) && !entry.isOfficial)
  )
}

function PluginRow({ entry }: { entry: PluginCatalogEntryView }): ReactElement {
  const t = useTranslations('settings.plugins')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const install = useInstallPlugin(storeId)
  const uninstall = useUninstallPlugin(storeId)
  const [consenting, setConsenting] = useState(false)
  const [viewing, setViewing] = useState(false)
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_PLUGINS)
  // A channel plugin and the shipping entry can be installed with one click; the others are registered by their manifest
  const isShipping = entry.id === ShippingPlugin.ID
  const external = needsConsent(entry)
  const installable = entry.channel !== null || isShipping || external
  const status = entry.installationStatus
  // An installation that exists and is not revoked: waiting for its plugin, turned off, or live
  const holds =
    entry.installed ||
    status === String(PluginInstallationStatus.PENDING_SETUP) ||
    status === String(PluginInstallationStatus.DISABLED)
  const isPending = status === String(PluginInstallationStatus.PENDING_SETUP)

  const askToUninstall = (): void => {
    const installationId = entry.installationId
    if (installationId === null) return
    const done = async (confirmation?: string): Promise<void> => {
      try {
        await uninstall.mutateAsync({
          installationId,
          ...(confirmation === undefined ? {} : { confirmation })
        })
        toast.success(t(confirmation === undefined ? 'uninstall.done' : 'revoke.done', { name: entry.name }))
      } catch (error) {
        toast.error(errorText(error))
      }
    }
    if (external) {
      run(REVOKE_ACTION, {
        title: t('revoke.title', { name: entry.name }),
        description: t('revoke.description', { name: entry.name }),
        confirmLabel: t('revoke.confirm'),
        phrase: PLUGIN_REVOKE_CONFIRMATION,
        onConfirm: () => done(PLUGIN_REVOKE_CONFIRMATION)
      })
      return
    }
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
      onConfirm: () => done()
    })
  }

  const doInstall = (): void => {
    if (external) {
      setConsenting(true)
      return
    }
    install.mutate(entry.id, {
      onSuccess: () =>
        toast.success(t(isShipping ? 'install.doneCarrier' : 'install.done', { name: entry.name })),
      onError: error => toast.error(errorText(error))
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium break-words">{entry.name}</h2>
        <span className="text-muted-foreground text-sm">
          {entry.isOfficial ? t('official') : t('by', { author: entry.authorName })}
          {entry.installed ? ` · ${t('installed')}` : ''}
          {isPending ? ` · ${t('pendingSetup')}` : ''}
          {status === String(PluginInstallationStatus.DISABLED) ? ` · ${t('disabled')}` : ''}
          {entry.installed && entry.activeConnections > 0
            ? ` · ${t('connections', { count: entry.activeConnections })}`
            : ''}
        </span>
        {entry.webhooksDisabledAt === null ? null : (
          <span className="text-sm text-amber-700 dark:text-amber-400">{t('webhooksOff')}</span>
        )}
      </div>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          {external && entry.webhooksDisabledAt !== null ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setConsenting(true)}>
              {t('reenable')}
              <span className="sr-only"> {entry.name}</span>
            </Button>
          ) : null}
          {external ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setViewing(true)}>
              {t('detail.action')}
              <span className="sr-only"> {entry.name}</span>
            </Button>
          ) : null}
          {holds ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uninstall.isPending}
              onClick={askToUninstall}
            >
              {external ? t('revoke.action') : t('uninstall.action')}
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
          )}
        </div>
      ) : null}
      {consenting ? (
        <PluginInstallDialog
          pluginId={entry.id}
          name={entry.name}
          onClose={() => setConsenting(false)}
        />
      ) : null}
      {viewing ? (
        <PluginDetailDialog
          pluginId={entry.id}
          name={entry.name}
          canManage={canManage}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </li>
  )
}
