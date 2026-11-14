'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

import { CarrierWebhookHeader } from './carrier-webhook-header'
import { CopyButton } from './copy-button'

// The secret of a carrier's webhook, once (TDD_17 §4.12): the api made it, keeps it sealed and never answers it again.
// It lives in the state of this dialog only and goes with it when it closes.
export function CarrierSecretDialog({
  connectionName,
  secret,
  webhookUrl,
  onClose
}: {
  connectionName: string
  secret: string
  webhookUrl: string | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.carriers.secret')
  const tAll = useTranslations()
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent
        // The secret is never shown again: only the button closes this, not a stray click or Escape
        onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('title', { name: connectionName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{t('once')}</span>
        </p>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('secretLabel')}</span>
          <div className="flex items-center gap-2">
            <code
              data-testid="carrier-webhook-secret"
              className="bg-muted min-w-0 flex-1 rounded-md px-2 py-1.5 font-mono text-sm break-all"
            >
              {secret}
            </code>
            <CopyButton text={secret} label={t('secretLabel')} />
          </div>
        </div>
        {webhookUrl === null ? null : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('urlLabel')}</span>
            <div className="flex items-center gap-2">
              <code className="bg-muted min-w-0 flex-1 rounded-md px-2 py-1.5 font-mono text-sm break-all">
                {webhookUrl}
              </code>
              <CopyButton text={webhookUrl} label={t('urlLabel')} />
            </div>
          </div>
        )}
        <CarrierWebhookHeader />
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {tAll('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
