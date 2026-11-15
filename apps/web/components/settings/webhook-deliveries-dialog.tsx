'use client'

import { Check, X } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { isWebhookEvent, WebhookDeliveryErrors } from '@platform/core/domain'

import { useWebhookDeliveries } from '../../lib/settings/use-integrations'
import { deliveryErrorCode } from '../../lib/settings/webhook-delivery'
import type { DeliveryOutcome, WebhookView } from '../../lib/settings/webhooks-requests'
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

import { LoadFailed } from './states'

const OUTCOMES: readonly DeliveryOutcome[] = ['all', 'failed', 'succeeded']
const KNOWN_ERRORS: readonly string[] = Object.values(WebhookDeliveryErrors)

// The log of the attempts to deliver one webhook, newest first (TDD_09 §13): the event, the answer of the receiver, how long it
// took and, for a failure, what went wrong in words. The api keeps thirty days of it.
export function WebhookDeliveriesDialog({
  webhook,
  onClose
}: {
  webhook: WebhookView
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.webhooks.deliveries')
  const tEvents = useTranslations('settings.webhooks.events')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const { storeId } = useStore()
  const [outcome, setOutcome] = useState<DeliveryOutcome>('all')
  const log = useWebhookDeliveries(storeId, webhook.id, outcome)
  const items = log.data?.pages.flatMap(page => page.items) ?? []

  const errorText = (error: string): string => {
    const { code, detail } = deliveryErrorCode(error)
    const known = KNOWN_ERRORS.includes(code) ? code : WebhookDeliveryErrors.UNEXPECTED
    return detail === null
      ? t(`errors.${known}` as 'errors.unexpected')
      : t('errorWithDetail', { reason: t(`errors.${known}` as 'errors.unexpected'), detail })
  }

  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">
            {t('description', { url: webhook.url })}
          </DialogDescription>
        </DialogHeader>
        <div role="group" aria-label={t('filterLabel')} className="flex flex-wrap gap-2">
          {OUTCOMES.map(item => (
            <Button
              key={item}
              type="button"
              size="sm"
              variant={item === outcome ? 'default' : 'outline'}
              aria-pressed={item === outcome}
              onClick={() => setOutcome(item)}
            >
              {t(`filter.${item}`)}
            </Button>
          ))}
        </div>
        {log.isError ? (
          <LoadFailed error={log.error} onRetry={() => void log.refetch()} />
        ) : log.data === undefined ? (
          <p role="status" className="text-muted-foreground py-6 text-center text-sm">
            {tCommon('loading')}
          </p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t('caption')}</caption>
              <thead>
                <tr className="text-muted-foreground border-b text-xs">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('columns.when')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('columns.event')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('columns.result')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('columns.status')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t('columns.duration')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} className="border-b align-top last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {format.dateTime(new Date(item.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'medium'
                      })}
                    </td>
                    <td className="py-2 pr-3">
                      {isWebhookEvent(item.event)
                        ? tEvents(item.event as 'order.created')
                        : item.event}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="flex items-start gap-1.5">
                        {item.success ? (
                          <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
                        ) : (
                          <X aria-hidden className="text-destructive mt-0.5 size-4 shrink-0" />
                        )}
                        <span>
                          {item.success
                            ? t('succeeded')
                            : item.error === null
                              ? t('failed')
                              : errorText(item.error)}
                          {item.attempt > 1 ? (
                            <span className="text-muted-foreground block text-xs">
                              {t('attempt', { number: item.attempt })}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </td>
                    <td className="py-2 pr-3">{item.statusCode ?? t('noStatus')}</td>
                    <td className="py-2 whitespace-nowrap">
                      {t('milliseconds', { count: item.durationMs })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          {log.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          ) : null}
          <Button type="button" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
