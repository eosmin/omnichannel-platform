'use client'

import {
  KeyRound,
  ListChecks,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  TriangleAlert,
  Webhook
} from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { WebhookHeaders, WebhookLimits, WebhookStatus } from '@platform/core/domain'

import {
  knownWebhookStatus,
  WEBHOOK_ACTIVE,
  WEBHOOK_DISABLED
} from '../../lib/settings/integration-status'
import {
  useDeleteWebhook,
  useRotateWebhookSecret,
  useUpdateWebhook
} from '../../lib/settings/use-integrations'
import type { WebhookView, WebhookWithSecretView } from '../../lib/settings/webhooks-requests'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { SecretOnceDialog } from './secret-once-dialog'
import { WebhookDeliveriesDialog } from './webhook-deliveries-dialog'
import { WebhookDialog } from './webhook-dialog'

type Editing = { kind: 'new' } | { kind: 'webhook'; webhook: WebhookView } | null

// Settings → Webhooks (TDD_09 §13; "Outgoing integrations" on screen): the addresses that receive the events of the store. The page opens
// only with settings:manage_webhooks and the api asks it for every call; `canManage` still gates the controls, so a panel
// drawn somewhere else cannot show a button its holder may not press.
export function WebhooksPanel({ webhooks }: { webhooks: WebhookView[] }): ReactElement {
  const t = useTranslations('settings.webhooks')
  const format = useFormatter()
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const update = useUpdateWebhook(storeId)
  const remove = useDeleteWebhook(storeId)
  const rotate = useRotateWebhookSecret(storeId)
  const [editing, setEditing] = useState<Editing>(null)
  const [logOf, setLogOf] = useState<WebhookView | null>(null)
  // The secret just made, shown once: it is dropped when the dialog closes
  const [secretOf, setSecretOf] = useState<WebhookWithSecretView | null>(null)
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_WEBHOOKS)
  const atLimit = webhooks.length >= WebhookLimits.MAX_PER_STORE

  const setStatus = (
    webhook: WebhookView,
    status: WebhookStatus.ACTIVE | WebhookStatus.PAUSED
  ): void => {
    update.mutate(
      { webhookId: webhook.id, input: { status } },
      {
        onSuccess: () => toast.success(t(status === WebhookStatus.ACTIVE ? 'resumed' : 'paused')),
        onError: error => toast.error(errorText(error))
      }
    )
  }

  const askToDelete = (webhook: WebhookView): void => {
    run('DELETE_WEBHOOK', {
      title: t('delete.title'),
      description: t('delete.description', { url: webhook.url }),
      confirmLabel: t('delete.confirm'),
      onConfirm: async () => {
        // The shared confirmation shows a generic error for a rejection: the reason of the api is said here
        try {
          await remove.mutateAsync(webhook.id)
          toast.success(t('delete.done'))
        } catch (error) {
          toast.error(errorText(error))
        }
      }
    })
  }

  const askToRotate = (webhook: WebhookView): void => {
    run('ROTATE_WEBHOOK_SECRET', {
      title: t('rotate.title'),
      description: t('rotate.description', { url: webhook.url }),
      confirmLabel: t('rotate.confirm'),
      onConfirm: async () => {
        try {
          // At once, with no wait for the confirmation to fade out: the secret exists only here, and the old one is dead
          setSecretOf(await rotate.mutateAsync(webhook.id))
          // The state of the page holds the secret now: the observer of the call must not hold it as well
          rotate.reset()
        } catch (error) {
          toast.error(errorText(error))
        }
      }
    })
  }

  const statusLabel = (status: string): string => {
    const known = knownWebhookStatus(status)
    return known === null ? status : t(`status.${known}`)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">{t('description')}</p>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            disabled={atLimit}
            onClick={() => setEditing({ kind: 'new' })}
          >
            <Plus aria-hidden className="size-4" />
            {t('create')}
          </Button>
        ) : null}
      </div>
      {atLimit ? (
        <p role="note" className="text-muted-foreground text-sm">
          {t('limit', { count: WebhookLimits.MAX_PER_STORE })}
        </p>
      ) : null}
      {webhooks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Webhook aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {webhooks.map(webhook => (
            <li key={webhook.id} className="flex flex-col gap-3 rounded-lg border p-4">
              <div className="flex flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="font-medium [overflow-wrap:anywhere]">{webhook.url}</h2>
                  <p className="text-muted-foreground text-sm">
                    <span>{statusLabel(webhook.status)}</span>
                    {' · '}
                    <span>{t('eventCount', { count: webhook.events.length })}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setLogOf(webhook)}
                  >
                    <ListChecks aria-hidden className="size-4" />
                    {t('log')}
                    <span className="sr-only"> {webhook.url}</span>
                  </Button>
                  {canManage ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing({ kind: 'webhook', webhook })}
                      >
                        <Pencil aria-hidden className="size-4" />
                        {t('edit')}
                        <span className="sr-only"> {webhook.url}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={update.isPending}
                        onClick={() =>
                          setStatus(
                            webhook,
                            webhook.status === WEBHOOK_ACTIVE
                              ? WebhookStatus.PAUSED
                              : WebhookStatus.ACTIVE
                          )
                        }
                      >
                        {webhook.status === WEBHOOK_ACTIVE ? (
                          <Pause aria-hidden className="size-4" />
                        ) : (
                          <Play aria-hidden className="size-4" />
                        )}
                        {webhook.status === WEBHOOK_ACTIVE
                          ? t('pause')
                          : webhook.status === WEBHOOK_DISABLED
                            ? t('turnOn')
                            : t('resume')}
                        <span className="sr-only"> {webhook.url}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={rotate.isPending}
                        onClick={() => askToRotate(webhook)}
                      >
                        <KeyRound aria-hidden className="size-4" />
                        {t('rotate.action')}
                        <span className="sr-only"> {webhook.url}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={remove.isPending}
                        onClick={() => askToDelete(webhook)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                        {t('delete.action')}
                        <span className="sr-only"> {webhook.url}</span>
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              {webhook.status === WEBHOOK_DISABLED ? (
                <p
                  role="note"
                  className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
                >
                  <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {t('disabledNotice', { count: WebhookLimits.MAX_CONSECUTIVE_FAILURES })}
                  </span>
                </p>
              ) : webhook.consecutiveFailures > 0 ? (
                <p className="text-muted-foreground text-sm">
                  {webhook.lastFailureAt === null
                    ? t('failingNoDate', {
                        count: webhook.consecutiveFailures,
                        limit: WebhookLimits.MAX_CONSECUTIVE_FAILURES
                      })
                    : t('failing', {
                        count: webhook.consecutiveFailures,
                        limit: WebhookLimits.MAX_CONSECUTIVE_FAILURES,
                        when: format.dateTime(new Date(webhook.lastFailureAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short'
                        })
                      })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <WebhookDialog
          key={editing.kind === 'webhook' ? editing.webhook.id : 'new'}
          webhook={editing.kind === 'webhook' ? editing.webhook : null}
          onCreated={created => {
            setEditing(null)
            setSecretOf(created)
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {logOf === null ? null : (
        <WebhookDeliveriesDialog webhook={logOf} onClose={() => setLogOf(null)} />
      )}
      {secretOf === null ? null : (
        <SecretOnceDialog
          title={t('secret.title')}
          description={t('secret.description', { url: secretOf.url })}
          label={t('secret.label')}
          secret={secretOf.secret}
          testId="webhook-secret"
          onClose={() => setSecretOf(null)}
        >
          <p className="text-muted-foreground text-sm">
            {t('secret.verify', { header: WebhookHeaders.SIGNATURE })}
          </p>
        </SecretOnceDialog>
      )}
    </div>
  )
}
