'use client'

import {
  CircleAlert,
  CircleCheck,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Unplug
} from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'
import {
  ChannelCapability,
  ChannelConnectionStatus,
  ChannelHealthErrors,
  ChannelIds,
  type DestructiveAction
} from '@platform/core/domain'

import { knownErrorCode } from '../../lib/error-message'
import type {
  ChannelConnectionView,
  PluginCatalogEntryView
} from '../../lib/settings/channels-requests'
import { ChannelMessagePrefix } from '../../lib/settings/connect-form'
import { useDisconnect, useTestConnection } from '../../lib/settings/use-channels'
import { useErrorText } from '../../lib/use-error-text'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { CallbackUrl } from './callback-url'
import { TemplatesList } from './templates-list'
import { WidgetCard } from './widget-card'

const DISCONNECT_ACTION: DestructiveAction = 'DISCONNECT_CHANNEL'
const HEALTH_CODES: readonly string[] = Object.values(ChannelHealthErrors)
// What the owner fixes by connecting again with another token (the others are for waiting or for Meta)
const RECONNECT_ERRORS: readonly string[] = [
  ChannelHealthErrors.TOKEN_REJECTED,
  ChannelHealthErrors.PERMISSION_MISSING,
  ChannelHealthErrors.OTHER_ACCOUNT,
  ChannelHealthErrors.ACCOUNT_NOT_LINKED,
  ChannelHealthErrors.REQUEST_REJECTED,
  ChannelHealthErrors.CREDENTIALS_UNREADABLE
]

// One account of a channel with its health and what the owner may do with it (TDD_09 §13). Nothing
// here is specific to one channel: the widget is the one card that exists only for the web widget,
// because its snippet and sites are not something a provider holds.
export function ConnectionCard({
  connection,
  plugin,
  onReconnect
}: {
  connection: ChannelConnectionView
  // The catalog entry of its plugin; absent while the catalog could not be read
  plugin: PluginCatalogEntryView | undefined
  // Opens the connect form of the channel again, for the failures that another token fixes
  onReconnect?: (plugin: PluginCatalogEntryView) => void
}): ReactElement {
  const t = useTranslations('settings.channels')
  const { can } = useStore()
  const isDown = connection.status === String(ChannelConnectionStatus.DISCONNECTED)
  const canEdit = can(Permissions.SETTINGS_EDIT)
  const canSeeTemplates =
    can(Permissions.CONVERSATIONS_VIEW) &&
    can(Permissions.MESSAGES_SEND_TEMPLATE) &&
    connection.capabilities.includes(ChannelCapability.TEMPLATES)

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate font-medium">{connection.displayName}</h2>
          <span className="text-muted-foreground text-sm">
            {plugin?.name ?? connection.pluginId}
          </span>
        </div>
        <StatusBadge status={connection.status} />
      </header>

      {isDown ? (
        <p className="text-muted-foreground text-sm">{t('disconnectedNote')}</p>
      ) : (
        <>
          <Health
            connection={connection}
            onReconnect={
              canEdit && plugin !== undefined && onReconnect !== undefined
                ? () => onReconnect(plugin)
                : undefined
            }
          />
          <ProfileStatus connection={connection} />
          {plugin?.channel?.callbackUrl != null ? (
            <CallbackUrl url={plugin.channel.callbackUrl} />
          ) : null}
          {canEdit ? <Actions connection={connection} /> : null}
          {connection.pluginId === ChannelIds.WEB_WIDGET ? (
            <Disclosure label={t('widget.toggle')}>
              <WidgetCard connectionId={connection.id} canEdit={canEdit} />
            </Disclosure>
          ) : null}
          {canSeeTemplates ? (
            <Disclosure label={t('templates.toggle')}>
              <TemplatesList pluginId={connection.pluginId} connectionId={connection.id} />
            </Disclosure>
          ) : null}
        </>
      )}
    </li>
  )
}

function StatusBadge({ status }: { status: string }): ReactElement {
  const t = useTranslations('settings.channels.status')
  if (status === String(ChannelConnectionStatus.ACTIVE)) {
    return (
      <span className="flex items-center gap-1 text-sm">
        <CircleCheck aria-hidden className="size-4 text-green-600" />
        {t('active')}
      </span>
    )
  }
  if (status === String(ChannelConnectionStatus.ERROR)) {
    return (
      <span className="text-destructive flex items-center gap-1 text-sm">
        <CircleAlert aria-hidden className="size-4" />
        {t('error')}
      </span>
    )
  }
  if (status === String(ChannelConnectionStatus.DISCONNECTED)) {
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-sm">
        <Unplug aria-hidden className="size-4" />
        {t('disconnected')}
      </span>
    )
  }
  // A status this page does not know (a server newer than the page): shown as it came
  return <span className="text-muted-foreground text-sm">{status}</span>
}

// When it last answered and, if it does not, why. The reasons the platform itself gives are codes; any
// other text is the provider's, shown as text and nothing else.
function Health({
  connection,
  onReconnect
}: {
  connection: ChannelConnectionView
  onReconnect: (() => void) | undefined
}): ReactElement {
  const t = useTranslations('settings.channels.health')
  const tChannels = useTranslations('settings.channels')
  const format = useFormatter()
  const error = connection.lastError
  return (
    <div className="flex flex-col gap-1 text-sm">
      {/* A failed check already says what happened: "not checked yet" beside it would contradict it */}
      {connection.lastHealthyAt === null && error !== null ? null : (
        <span className="text-muted-foreground">
          {connection.lastHealthyAt === null
            ? t('never')
            : t('lastHealthy', {
                date: format.dateTime(new Date(connection.lastHealthyAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })
              })}
        </span>
      )}
      {error === null ? null : (
        <p role="alert" className="text-destructive break-words">
          {HEALTH_CODES.includes(error) ? t(`errors.${error}` as 'errors.check_failed') : error}
        </p>
      )}
      {error !== null && onReconnect !== undefined && RECONNECT_ERRORS.includes(error) ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={onReconnect}
        >
          <RefreshCw aria-hidden />
          {tChannels('reconnect')}
        </Button>
      ) : null}
    </div>
  )
}

// Step 2.8 (1c-2): customers whose name and photo could not be read, and what the owner does about it
function ProfileStatus({ connection }: { connection: ChannelConnectionView }): ReactElement | null {
  const t = useTranslations()
  const profile = connection.profile
  if (profile === null || profile.failedIdentities === 0) return null
  const setupKey = profile.setupKey
  return (
    <div role="status" className="bg-muted flex flex-col gap-1 rounded-md p-3 text-sm">
      <p className="font-medium">
        {t('settings.channels.profile.title', { count: profile.failedIdentities })}
      </p>
      <ul className="list-disc pl-5">
        {profile.errors.map(item => (
          <li key={item.code}>
            {t(`errors.${knownErrorCode(item.code)}`)} ({item.identities})
          </li>
        ))}
      </ul>
      {setupKey !== null &&
      setupKey.startsWith(ChannelMessagePrefix) &&
      t.has(setupKey as Parameters<typeof t.has>[0]) ? (
        <p>{t(setupKey as Parameters<typeof t>[0])}</p>
      ) : null}
    </div>
  )
}

function Actions({ connection }: { connection: ChannelConnectionView }): ReactElement {
  const t = useTranslations('settings.channels')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const run = useDestructiveAction()
  const test = useTestConnection(storeId, connection.id)
  const disconnect = useDisconnect(storeId)
  const format = useFormatter()

  const askToDisconnect = (): void => {
    run(DISCONNECT_ACTION, {
      title: t('disconnect.title', { name: connection.displayName }),
      description: t('disconnect.description'),
      confirmLabel: t('disconnect.confirm'),
      onConfirm: async () => {
        try {
          await disconnect.mutateAsync(connection.id)
          toast.success(t('disconnect.done', { name: connection.displayName }))
        } catch (error) {
          toast.error(errorText(error))
        }
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? t('test.running') : t('test.action')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={askToDisconnect}>
          <Unplug aria-hidden />
          {t('disconnect.action')}
          <span className="sr-only"> {connection.displayName}</span>
        </Button>
      </div>
      {test.data === undefined ? null : (
        <p role="status" className={test.data.healthy ? 'text-sm' : 'text-destructive text-sm'}>
          {test.data.healthy ? t('test.healthy') : t('test.unhealthy')}{' '}
          <span className="text-muted-foreground">
            {format.dateTime(new Date(test.data.checkedAt), { timeStyle: 'short' })}
          </span>
        </p>
      )}
      <MutationError error={test.error} />
    </div>
  )
}

function Disclosure({ label, children }: { label: string; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false)
  const id = useId()
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="hover:bg-accent flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-sm font-medium"
      >
        <Icon aria-hidden className="size-4" />
        {label}
      </button>
      {open ? <div id={id}>{children}</div> : null}
    </div>
  )
}
