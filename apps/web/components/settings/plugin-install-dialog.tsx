'use client'

import { ExternalLink, ShieldAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { PluginInstallationStatus } from '@platform/core/domain'

import { useErrorText } from '../../lib/use-error-text'
import { useSubmitGuard } from '../../lib/submit-guard'
import type { PluginSetupOfferView } from '../../lib/settings/plugins-requests'
import { useInstallIntegrationPlugin, usePluginConsent } from '../../lib/settings/use-plugins'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

import { ScopeList } from './plugin-scopes'
import { PluginSetupCodeDialog } from './plugin-setup-code-dialog'
import { LoadFailed, PageLoading } from './states'

// The consent screen of an integration plugin (TDD_10 §6.3): what it asks for, exactly, before the owner authorizes it. The texts of the
// manifest are the author's, drawn as text. The scopes sent are the ones shown here; the api refuses the install if the manifest asks
// for others by then. The install ends with the one-time setup code, which the plugin trades for its key.
export function PluginInstallDialog({
  pluginId,
  name,
  onClose
}: {
  pluginId: string
  name: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.plugins.consent')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const consent = usePluginConsent(storeId, pluginId)
  const install = useInstallIntegrationPlugin(storeId, pluginId)
  const guard = useSubmitGuard()
  // The code outlives the consent screen: it is shown on its own dialog, once
  const [offer, setOffer] = useState<PluginSetupOfferView | null>(null)

  if (offer !== null) {
    return <PluginSetupCodeDialog offer={offer} name={name} onClose={onClose} />
  }

  const data = consent.data
  // An installation that exists and is not revoked: what a newer manifest adds is a change to access already trusted
  const isLive =
    data?.installation != null && data.installation.status !== String(PluginInstallationStatus.REVOKED)
  const authorize = (): void => {
    if (data === undefined || !guard.enter()) return
    install.mutate(data.scopes, {
      onSuccess: result => {
        if (result.setup === null) {
          // An installation that was already active took the new scopes and has its key: there is no code
          toast.success(t('updated', { name }))
          onClose()
        } else {
          setOffer(result.setup)
          // The code lives in the state of the dialog that shows it, not in the cache of the call
          install.reset()
        }
      },
      onError: error => toast.error(errorText(error)),
      onSettled: guard.leave
    })
  }

  return (
    <Dialog open onOpenChange={open => (open || install.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {consent.isError ? (
          <LoadFailed error={consent.error} onRetry={() => void consent.refetch()} />
        ) : data === undefined ? (
          <PageLoading />
        ) : (
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-1 text-sm">
              <h3 className="font-medium">
                {data.plugin.name} <span className="text-muted-foreground">v{data.plugin.version}</span>
              </h3>
              <p className="break-words">{data.plugin.description}</p>
              <p className="text-muted-foreground break-all">
                {t('author', { author: data.plugin.authorName, email: data.plugin.authorEmail })}
              </p>
              <p className="text-muted-foreground text-xs">{t('authorOwn')}</p>
            </section>
            {data.newScopes.length > 0 && isLive ? (
              <p role="note" className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{t('newVersion')}</span>
              </p>
            ) : null}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('scopesTitle')}</h3>
              <ScopeList scopes={data.scopes} highlight={isLive ? data.newScopes : []} />
              <p className="text-muted-foreground text-xs">{t('scopesNote')}</p>
            </section>
            <section className="flex flex-col gap-1 text-sm">
              <h3 className="font-medium">{t('limitsTitle')}</h3>
              <p>{t('rateLimit', { count: data.rateLimitPerMinute })}</p>
              {data.webhooks === null ? (
                <p>{t('noWebhooks')}</p>
              ) : (
                <>
                  <p className="break-all">{t('webhookEndpoint', { endpoint: data.webhooks.endpoint })}</p>
                  <p className="text-muted-foreground text-xs">{t('challengeNote')}</p>
                  <p className="break-all">{t('webhookEvents', { events: data.webhooks.events.join(', ') })}</p>
                </>
              )}
            </section>
            {data.legal.privacyPolicy !== null || data.legal.termsOfService !== null ? (
              <section className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {data.legal.privacyPolicy === null ? null : (
                  <ExternalText href={data.legal.privacyPolicy} label={t('privacy')} />
                )}
                {data.legal.termsOfService === null ? null : (
                  <ExternalText href={data.legal.termsOfService} label={t('terms')} />
                )}
              </section>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={install.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            // A refresh that failed hides what is asked: nothing is authorized that the owner cannot see
            disabled={data === undefined || consent.isError || consent.isFetching || install.isPending}
            busy={install.isPending}
            onClick={authorize}
          >
            {t('authorize')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ExternalText({ href, label }: { href: string; label: string }): ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-2"
    >
      {label}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  )
}
