'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { PluginCatalogTypes, PluginInstallationStatus } from '@platform/core/domain'

import type { PluginSetupOfferView } from '../../lib/settings/plugins-requests'
import {
  usePluginDetail,
  useReissueSetupCode,
  useRotateCommandSecret
} from '../../lib/settings/use-plugins'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { PluginInstallDialog } from './plugin-install-dialog'
import { ScopeList } from './plugin-scopes'
import { PluginSetupCodeDialog } from './plugin-setup-code-dialog'
import { SecretOnceDialog } from './secret-once-dialog'
import { LoadFailed, PageLoading } from './states'

// What the store holds of one plugin: the scopes it was granted, the prefix of its key (never the key), the state of its webhooks and
// the actions that follow from the state (a new setup code, a new command secret). The texts of the plugin are drawn as text.
export function PluginDetailDialog({
  pluginId,
  name,
  canManage,
  onClose
}: {
  pluginId: string
  name: string
  canManage: boolean
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.plugins.detail')
  const errorText = useErrorText()
  const format = useFormatter()
  const { storeId } = useStore()
  const detail = usePluginDetail(storeId, pluginId)
  const reissue = useReissueSetupCode(storeId)
  const rotate = useRotateCommandSecret(storeId)
  const [offer, setOffer] = useState<PluginSetupOfferView | null>(null)
  const [commandSecret, setCommandSecret] = useState<string | null>(null)
  const [consenting, setConsenting] = useState(false)

  const day = (iso: string): string =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

  if (offer !== null) {
    return (
      <PluginSetupCodeDialog
        offer={offer}
        name={name}
        onClose={() => {
          setOffer(null)
          reissue.reset()
        }}
      />
    )
  }
  if (commandSecret !== null) {
    return (
      <SecretOnceDialog
        title={t('commandSecret.title', { name })}
        description={t('commandSecret.description')}
        label={t('commandSecret.label')}
        secret={commandSecret}
        testId="plugin-command-secret"
        onClose={() => {
          setCommandSecret(null)
          rotate.reset()
        }}
      />
    )
  }

  const data = detail.data
  const installation = data?.installation ?? null
  const isLive =
    installation !== null && installation.status !== String(PluginInstallationStatus.REVOKED)
  const isPending = installation?.status === String(PluginInstallationStatus.PENDING_SETUP)
  // What a newer manifest asks for beyond what this installation was granted: nothing is granted until the owner authorizes it again
  const asksForMore =
    data !== undefined && isLive && installation !== null
      ? data.requestedScopes.filter(scope => !installation.scopes.includes(scope))
      : []
  const isRemoteChannel =
    data !== undefined && data.type === String(PluginCatalogTypes.CHANNEL) && !data.isOfficial

  return (
    <>
      <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>
              {data?.version == null ? t('noVersion') : t('version', { version: data.version })}
            </DialogDescription>
          </DialogHeader>
          {detail.isError ? (
            <LoadFailed error={detail.error} onRetry={() => void detail.refetch()} />
          ) : data === undefined ? (
            <PageLoading />
          ) : (
            <div className="flex flex-col gap-4 text-sm">
              {data.description === null ? null : <p className="break-words">{data.description}</p>}
              <p className="text-muted-foreground">
                {data.isOfficial ? t('official') : t('by', { author: data.authorName })}
              </p>
              {installation === null ? (
                <p>{t('neverInstalled')}</p>
              ) : (
                <dl className="grid grid-cols-1 gap-2">
                  <Row label={t('status.label')} testId="plugin-status">
                    {t(`status.${installation.status}` as Parameters<typeof t>[0])}
                  </Row>
                  <Row label={t('installedAt')}>{day(installation.installedAt)}</Row>
                  {installation.revokedAt === null ? null : (
                    <Row label={t('revokedAt')}>{day(installation.revokedAt)}</Row>
                  )}
                  {installation.apiKeyPrefix === null ? null : (
                    <Row label={t('keyPrefix')}>
                      <code className="font-mono break-all">{installation.apiKeyPrefix}…</code>
                    </Row>
                  )}
                  {isLive ? (
                    <Row label={t('rateLimit')}>
                      {t('perMinute', { count: installation.rateLimitPerMinute })}
                    </Row>
                  ) : null}
                  {installation.webhookEndpoint === null ? null : (
                    <Row label={t('webhookEndpoint')}>
                      <span className="break-all">{installation.webhookEndpoint}</span>
                    </Row>
                  )}
                </dl>
              )}
              {installation?.webhookDisabledAt == null ? null : (
                <p
                  role="alert"
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3"
                >
                  {t('webhooksOff', { time: day(installation.webhookDisabledAt) })}
                </p>
              )}
              {installation !== null &&
              installation.webhookDisabledAt === null &&
              installation.webhookConsecutiveFailures > 0 &&
              installation.webhookLastFailureAt !== null ? (
                <p className="text-muted-foreground">
                  {t('webhookFailures', {
                    count: installation.webhookConsecutiveFailures,
                    time: day(installation.webhookLastFailureAt)
                  })}
                </p>
              ) : null}
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">{isLive ? t('granted') : t('requested')}</h3>
                <ScopeList
                  scopes={
                    isLive && installation !== null ? installation.scopes : data.requestedScopes
                  }
                />
              </section>
              {data.webhookEvents.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <h3 className="font-medium">{t('events')}</h3>
                  <p className="text-muted-foreground break-words">
                    {data.webhookEvents.join(', ')}
                  </p>
                </section>
              ) : null}
              {asksForMore.length > 0 ? (
                <p
                  role="note"
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3"
                >
                  {t('asksForMore', { count: asksForMore.length })}
                </p>
              ) : null}
              {canManage &&
              isLive &&
              (asksForMore.length > 0 || installation?.webhookDisabledAt != null) ? (
                <Button type="button" variant="outline" onClick={() => setConsenting(true)}>
                  {t('reauthorize')}
                </Button>
              ) : null}
              {canManage && installation !== null && isPending ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={reissue.isPending}
                  busy={reissue.isPending}
                  onClick={() =>
                    reissue.mutate(installation.id, {
                      onSuccess: setOffer,
                      onError: error => toast.error(errorText(error))
                    })
                  }
                >
                  {t('newCode')}
                </Button>
              ) : null}
              {canManage && installation !== null && isLive && !isPending && isRemoteChannel ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={rotate.isPending}
                  busy={rotate.isPending}
                  onClick={() =>
                    rotate.mutate(installation.id, {
                      onSuccess: result => setCommandSecret(result.commandSecret),
                      onError: error => toast.error(errorText(error))
                    })
                  }
                >
                  {t('rotateSecret')}
                </Button>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
      {consenting ? (
        <PluginInstallDialog pluginId={pluginId} name={name} onClose={() => setConsenting(false)} />
      ) : null}
    </>
  )
}

function Row({
  label,
  testId,
  children
}: {
  label: string
  testId?: string
  children: React.ReactNode
}): ReactElement {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="text-muted-foreground sm:w-40 sm:shrink-0">{label}</dt>
      <dd data-testid={testId} className="min-w-0">
        {children}
      </dd>
    </div>
  )
}
