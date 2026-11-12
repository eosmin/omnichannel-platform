'use client'

import { CircleAlert, CircleCheck, KeyRound, Pencil, Stethoscope, Unplug } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { CarrierConnectionView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  CarrierConnectionStatus,
  CarrierHealthReasons,
  type DestructiveAction
} from '@platform/core/domain'

import { canReceiveWebhook } from '../../lib/settings/carriers-form'
import {
  useDisconnectCarrier,
  useRotateWebhookSecret,
  useTestCarrier
} from '../../lib/settings/use-carriers'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { CopyButton } from './copy-button'

const DISCONNECT_ACTION: DestructiveAction = 'DISCONNECT_CARRIER_WITH_OPEN_SHIPMENTS'
const ROTATE_ACTION: DestructiveAction = 'ROTATE_CARRIER_WEBHOOK_SECRET'
const HEALTH_REASONS: readonly string[] = Object.values(CarrierHealthReasons)

// One connection of a carrier with its health and what the owner may do with it. The controls show only for who holds
// settings:manage_carriers, and each one only where the connection declares what it needs (the webhook secret, for one
// that pushes statuses). Nothing here knows a carrier by name.
export function CarrierCard({
  connection,
  onEdit,
  onSecret
}: {
  connection: CarrierConnectionView
  onEdit: (connection: CarrierConnectionView) => void
  // The new secret of the webhook, to be shown once
  onSecret: (connection: CarrierConnectionView, secret: string) => void
}): ReactElement {
  const t = useTranslations('settings.carriers.card')
  const tAll = useTranslations()
  const format = useFormatter()
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const test = useTestCarrier(storeId, connection.id)
  const rotate = useRotateWebhookSecret(storeId, connection.id)
  const disconnect = useDisconnectCarrier(storeId)
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_CARRIERS)
  const disconnected = connection.status === String(CarrierConnectionStatus.DISABLED)
  const needsAttention = connection.status === String(CarrierConnectionStatus.ERROR)
  const pushes = canReceiveWebhook(connection.capabilities)
  const busy = test.isPending || rotate.isPending || disconnect.isPending

  const runTest = (): void => {
    test.mutate(undefined, {
      onSuccess: result =>
        result.healthy
          ? toast.success(t('test.healthy', { name: connection.displayName }))
          : toast.error(t('test.unhealthy', { name: connection.displayName })),
      onError: error => toast.error(errorText(error))
    })
  }

  const askToRotate = (): void =>
    run(ROTATE_ACTION, {
      title: t('rotate.title', { name: connection.displayName }),
      description: t('rotate.description'),
      confirmLabel: t('rotate.confirm'),
      onConfirm: async () => {
        try {
          const made = await rotate.mutateAsync()
          onSecret(connection, made.webhookSecret)
        } catch (error) {
          toast.error(errorText(error))
        }
      }
    })

  const askToDisconnect = (): void =>
    run(DISCONNECT_ACTION, {
      title: t('disconnect.title', { name: connection.displayName }),
      description: t('disconnect.description', {
        shipments: connection.openShipments,
        pickups: connection.openPickups
      }),
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

  const reason =
    connection.lastError === null
      ? null
      : HEALTH_REASONS.includes(connection.lastError)
        ? tAll(`settings.carriers.health.${connection.lastError}` as 'errors.INTERNAL_ERROR')
        : t('healthUnknown')

  return (
    <li
      data-testid="carrier-card"
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={connection.displayName}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-medium break-words">{connection.displayName}</h3>
          <span className="text-muted-foreground text-sm">
            {connection.carrierName}
            {connection.isDefault ? ` · ${t('default')}` : ''}
          </span>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
            needsAttention ? 'border-destructive/50 text-destructive' : ''
          }`}
        >
          {needsAttention ? (
            <CircleAlert aria-hidden className="size-3" />
          ) : (
            <CircleCheck aria-hidden className="size-3" />
          )}
          {t(`status.${connection.status}` as 'status.active')}
        </span>
      </div>

      {disconnected ? (
        <p className="text-muted-foreground text-sm">{t('disconnectedNote')}</p>
      ) : (
        <>
          {reason === null ? null : (
            <p role="status" className="text-destructive text-sm">
              {reason}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {connection.lastHealthyAt === null
              ? t('neverHealthy')
              : t('lastHealthy', {
                  date: format.dateTime(new Date(connection.lastHealthyAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short'
                  })
                })}
          </p>
          <ul aria-label={t('capabilities')} className="flex flex-wrap gap-1.5">
            {connection.capabilities.map(capability => (
              <li key={capability} className="bg-muted rounded-md px-2 py-0.5 text-xs">
                {tAll(`settings.carriers.capabilities.${capability}` as 'errors.INTERNAL_ERROR')}
              </li>
            ))}
          </ul>
          {pushes ? (
            <div className="flex flex-col gap-1 text-sm">
              <span>
                {connection.hasWebhookSecret ? t('webhook.secretSet') : t('webhook.secretMissing')}
              </span>
              {connection.webhookUrl === null ? null : (
                <div className="flex items-center gap-2">
                  <code className="bg-muted min-w-0 flex-1 rounded-md px-2 py-1 font-mono text-xs break-all">
                    {connection.webhookUrl}
                  </code>
                  <CopyButton text={connection.webhookUrl} label={t('webhook.url')} />
                </div>
              )}
            </div>
          ) : null}
        </>
      )}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onEdit(connection)}>
            <Pencil aria-hidden />
            {disconnected ? t('rename') : t('edit')}
            <span className="sr-only"> {connection.displayName}</span>
          </Button>
          {disconnected ? null : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                busy={test.isPending}
                onClick={runTest}
              >
                <Stethoscope aria-hidden />
                {t('test.action')}
                <span className="sr-only"> {connection.displayName}</span>
              </Button>
              {pushes ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={askToRotate}
                >
                  <KeyRound aria-hidden />
                  {t('rotate.action')}
                  <span className="sr-only"> {connection.displayName}</span>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={askToDisconnect}
              >
                <Unplug aria-hidden />
                {t('disconnect.action')}
                <span className="sr-only"> {connection.displayName}</span>
              </Button>
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}
