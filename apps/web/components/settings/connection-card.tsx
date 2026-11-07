'use client'

import {
  CircleAlert,
  CircleCheck,
  Clock,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Pencil,
  Unplug
} from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import {
  ChannelCapability,
  ChannelConnectionStatus,
  ChannelHealthErrors,
  ChannelIds,
  type DestructiveAction
} from '@platform/core/domain'

import type {
  ChannelConnectionView,
  PluginCatalogEntryView
} from '../../lib/settings/channels-requests'
import { ChannelMessagePrefix } from '../../lib/settings/connect-form'
import { needsNewToken } from '../../lib/settings/health-reconnect'
import { tokenNotice } from '../../lib/settings/token-expiry'
import { useDisconnect, useTestConnection } from '../../lib/settings/use-channels'
import { toast } from '../../lib/toast'
import { useCodeText, useErrorText } from '../../lib/use-error-text'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { CallbackUrl } from './callback-url'
import { FacebookLoginButton } from './facebook-login-button'
import { RenameDialog } from './rename-dialog'
import { TemplatesList } from './templates-list'
import { WidgetCard } from './widget-card'

const DISCONNECT_ACTION: DestructiveAction = 'DISCONNECT_CHANNEL'
const HEALTH_CODES: readonly string[] = Object.values(ChannelHealthErrors)

// One account of a channel with its health and what the owner may do with it (TDD_09 §13). Nothing
// here is specific to one channel: the widget is the one card that exists only for the web widget,
// because its snippet and sites are not something a provider holds.
export function ConnectionCard({
  connection,
  plugin,
  onUpdateToken
}: {
  connection: ChannelConnectionView
  // The catalog entry of its plugin; absent while the catalog could not be read
  plugin: PluginCatalogEntryView | undefined
  // Opens the dialog that replaces the token of THIS connection (not the form to connect a new one)
  onUpdateToken?: (connection: ChannelConnectionView, plugin: PluginCatalogEntryView) => void
}): ReactElement {
  const t = useTranslations('settings.channels')
  const { can } = useStore()
  const [renaming, setRenaming] = useState(false)
  const isDown = connection.status === String(ChannelConnectionStatus.DISCONNECTED)
  const canEdit = can(ClientPermissions.SETTINGS_EDIT)
  const canSeeTemplates =
    can(ClientPermissions.CONVERSATIONS_VIEW) &&
    can(ClientPermissions.MESSAGES_SEND_TEMPLATE) &&
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
          <Health connection={connection} />
          <TokenExpiry connection={connection} />
          <ProfileStatus connection={connection} />
          {plugin?.channel?.callbackUrl != null ? (
            <CallbackUrl url={plugin.channel.callbackUrl} />
          ) : null}
          {canEdit ? (
            <Actions
              connection={connection}
              onRename={() => setRenaming(true)}
              reconnectWithFacebook={
                plugin?.channel?.facebookLogin === true &&
                connection.status === String(ChannelConnectionStatus.ERROR)
              }
              onUpdateToken={
                plugin !== undefined &&
                onUpdateToken !== undefined &&
                plugin.channel?.connectFields.some(field => field.secret) === true
                  ? () => onUpdateToken(connection, plugin)
                  : undefined
              }
            />
          ) : null}
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
      {renaming && !isDown ? (
        <RenameDialog connection={connection} onClose={() => setRenaming(false)} />
      ) : null}
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
function Health({ connection }: { connection: ChannelConnectionView }): ReactElement {
  const t = useTranslations('settings.channels.health')
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
    </div>
  )
}

// What the provider says about the token of the connection: when it stops, or that it does not, or that it
// no longer works; and, if what was pasted is the token of a person, which one the channel needs. Nothing is
// said while it is not known (never asked, or Meta could not be): "unknown" is not "expired".
function TokenExpiry({ connection }: { connection: ChannelConnectionView }): ReactElement | null {
  const t = useTranslations('settings.channels.health.token')
  const format = useFormatter()
  const notice = tokenNotice(connection.tokenExpiry, new Date())
  if (notice.when === 'none' && !notice.userToken) return null
  const date = notice.date === null ? '' : format.dateTime(notice.date, { dateStyle: 'medium' })

  return (
    <div className="flex flex-col gap-1 text-sm">
      {notice.when === 'never' ? <p className="text-muted-foreground">{t('never')}</p> : null}
      {notice.when === 'expires' ? (
        <p className="text-muted-foreground">{t('expires', { date })}</p>
      ) : null}
      {notice.when === 'soon' ? (
        <p
          role="status"
          className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400"
        >
          <Clock aria-hidden className="size-4" />
          {t('expires', { date })}
        </p>
      ) : null}
      {notice.when === 'expired' ? (
        <p role="alert" className="text-destructive">
          {t('expired', { date })}
        </p>
      ) : null}
      {notice.when === 'expiredUnknownDate' ? (
        <p role="alert" className="text-destructive">
          {t('expiredUnknownDate')}
        </p>
      ) : null}
      {notice.when === 'invalid' ? (
        <p role="alert" className="text-destructive">
          {t('invalid')}
        </p>
      ) : null}
      {notice.userToken ? <p className="text-muted-foreground">{t('userToken')}</p> : null}
    </div>
  )
}

// Step 2.8 (1c-2): customers whose name and photo could not be read, and what the owner does about it
function ProfileStatus({ connection }: { connection: ChannelConnectionView }): ReactElement | null {
  const t = useTranslations()
  const codeText = useCodeText()
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
            {codeText(item.code)} ({item.identities})
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

function Actions({
  connection,
  onRename,
  onUpdateToken,
  reconnectWithFacebook
}: {
  connection: ChannelConnectionView
  onRename: () => void
  onUpdateToken: (() => void) | undefined
  // The connection is in error and its channel has the login: it can be made again from Facebook
  reconnectWithFacebook: boolean
}): ReactElement {
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
          <span className="sr-only"> {connection.displayName}</span>
        </Button>
        {reconnectWithFacebook ? (
          <FacebookLoginButton
            pluginId={connection.pluginId}
            connectionId={connection.id}
            variant="outline"
            size="sm"
            idleLabel={t('oauth.reconnect')}
            accessibleSuffix={connection.displayName}
          />
        ) : null}
        {onUpdateToken === undefined ? null : (
          // Always there, and the main action when the failure is one that a new token fixes
          <Button
            type="button"
            variant={
              connection.lastError !== null && needsNewToken(connection.lastError)
                ? 'default'
                : 'outline'
            }
            size="sm"
            onClick={onUpdateToken}
          >
            <KeyRound aria-hidden />
            {t('updateToken.action')}
            <span className="sr-only"> {connection.displayName}</span>
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onRename}>
          <Pencil aria-hidden />
          {t('rename.action')}
          <span className="sr-only"> {connection.displayName}</span>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={askToDisconnect}>
          <Unplug aria-hidden />
          {t('disconnect.action')}
          <span className="sr-only"> {connection.displayName}</span>
        </Button>
      </div>
      {test.data === undefined ? null : (
        <p role="status" className={test.data.healthy ? 'text-sm' : 'text-destructive text-sm'}>
          {test.data.healthy
            ? t('test.healthy')
            : t(onUpdateToken === undefined ? 'test.unhealthy' : 'test.unhealthyWithToken')}{' '}
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
