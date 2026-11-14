'use client'

import { Ban, KeyRound, Plus } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { ApiKeyLimits } from '@platform/core/domain'

import type { ApiKeyView, ApiKeyWithTokenView } from '../../lib/settings/api-keys-requests'
import { API_KEY_ACTIVE, knownApiKeyStatus } from '../../lib/settings/integration-status'
import { useRevokeApiKey } from '../../lib/settings/use-integrations'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { ApiKeyDialog } from './api-key-dialog'
import { SecretOnceDialog } from './secret-once-dialog'

// Settings → API keys (TDD_09 §13): the credentials an integration of the store uses. Only the first characters of a key are
// ever shown again; revoking one is the critical tier (a typed phrase), because the integration that uses it stops at once.
export function ApiKeysPanel({ keys }: { keys: ApiKeyView[] }): ReactElement {
  const t = useTranslations('settings.apiKeys')
  const tScopes = useTranslations('settings.team.permissions')
  const format = useFormatter()
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const revoke = useRevokeApiKey(storeId)
  const [creating, setCreating] = useState(false)
  // The key just made, shown once: it is dropped when the dialog closes and is not kept anywhere else
  const [made, setMade] = useState<ApiKeyWithTokenView | null>(null)
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_API_KEYS)
  const active = keys.filter(key => key.status === API_KEY_ACTIVE).length
  const atLimit = active >= ApiKeyLimits.MAX_PER_STORE

  const statusText = (status: string): string => {
    const known = knownApiKeyStatus(status)
    return known === null ? status : t(`status.${known}`)
  }
  const day = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: 'medium' })
  const scopeName = (scope: string): string =>
    tScopes.has(scope.replace(':', '.') as 'settings.view')
      ? tScopes(scope.replace(':', '.') as 'settings.view')
      : scope

  const askToRevoke = (key: ApiKeyView): void => {
    run('REVOKE_API_KEY', {
      title: t('revoke.title', { name: key.name }),
      description: t('revoke.description', { prefix: key.keyPrefix }),
      confirmLabel: t('revoke.confirm'),
      // The name is what the person sees on the list: they type what they read
      phrase: key.name,
      onConfirm: async () => {
        // The shared confirmation shows a generic error for a rejection: the reason of the api is said here
        try {
          await revoke.mutateAsync(key.id)
          toast.success(t('revoke.done', { name: key.name }))
        } catch (error) {
          toast.error(errorText(error))
        }
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">{t('description')}</p>
        {canManage ? (
          <Button type="button" size="sm" disabled={atLimit} onClick={() => setCreating(true)}>
            <Plus aria-hidden className="size-4" />
            {t('create')}
          </Button>
        ) : null}
      </div>
      {atLimit ? (
        <p role="note" className="text-muted-foreground text-sm">
          {t('limit', { count: ApiKeyLimits.MAX_PER_STORE })}
        </p>
      ) : null}
      {keys.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <KeyRound aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {keys.map(key => (
            <li key={key.id} className="flex flex-col gap-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h2 className="font-medium [overflow-wrap:anywhere]">{key.name}</h2>
                  <p className="text-muted-foreground text-sm">
                    <code className="font-mono">{key.keyPrefix}…</code>
                    {' · '}
                    <span>{statusText(key.status)}</span>
                  </p>
                </div>
                {canManage && key.status === API_KEY_ACTIVE ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={() => askToRevoke(key)}
                  >
                    <Ban aria-hidden className="size-4" />
                    {t('revoke.action')}
                    <span className="sr-only"> {key.name}</span>
                  </Button>
                ) : null}
              </div>
              <dl className="text-muted-foreground grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex gap-1">
                  <dt>{t('created')}</dt>
                  <dd>{day(key.createdAt)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>{t('lastUsed')}</dt>
                  <dd>{key.lastUsedAt === null ? t('neverUsed') : day(key.lastUsedAt)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>{t('expires')}</dt>
                  <dd>{key.expiresAt === null ? t('noExpiry') : day(key.expiresAt)}</dd>
                </div>
                {key.revokedAt === null ? null : (
                  <div className="flex gap-1">
                    <dt>{t('revokedOn')}</dt>
                    <dd>{day(key.revokedAt)}</dd>
                  </div>
                )}
              </dl>
              <p className="text-sm [overflow-wrap:anywhere]">
                <span className="text-muted-foreground">{t('scopes')}: </span>
                {key.scopes.map(scopeName).join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <ApiKeyDialog
          onCreated={created => {
            setCreating(false)
            setMade(created)
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {made === null ? null : (
        <SecretOnceDialog
          title={t('secret.title', { name: made.name })}
          description={t('secret.description')}
          label={t('secret.label')}
          secret={made.key}
          testId="api-key-secret"
          onClose={() => setMade(null)}
        >
          <p className="text-muted-foreground text-sm">{t('secret.use')}</p>
        </SecretOnceDialog>
      )}
    </div>
  )
}
