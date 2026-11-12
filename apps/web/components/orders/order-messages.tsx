'use client'

import { Eye, Send } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useId, useRef, useState } from 'react'

import type { OrderDetailView, OrderMessageHistoryItemView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { DeliveryStatus, OrderMessageOutcomeStatus } from '@platform/core/domain'

import {
  knownDelivery,
  knownKind,
  knownReason,
  knownRoute,
  MANUAL_MESSAGE_KINDS
} from '../../lib/orders/order-messages-rules'
import { useOrderMessageHistory, useOrderMessageWrites } from '../../lib/orders/use-order-messages'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

function HistoryRow({ item }: { item: OrderMessageHistoryItemView }): ReactElement {
  const t = useTranslations('orders.detail.messages')
  const format = useFormatter()
  const kind = knownKind(item.kind)
  const route = knownRoute(item.route)
  const reason = item.reason === null ? null : knownReason(item.reason)
  const delivery = item.deliveryStatus === null ? null : knownDelivery(item.deliveryStatus)
  const notSent = item.status === OrderMessageOutcomeStatus.NOT_SENT
  return (
    <li className="flex flex-col gap-1 rounded border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{kind === null ? t('unknownKind') : t(`kind.${kind}`)}</span>
        <span className="rounded border px-1.5 py-0.5 text-xs font-medium">
          {notSent ? t('status.not_sent') : t('status.sent')}
        </span>
        <time dateTime={item.createdAt} className="text-muted-foreground text-xs">
          {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </div>
      <p className="text-muted-foreground text-xs">
        {route === null ? t('unknownRoute') : t(`route.${route}`)}
        {' · '}
        {item.requestedBy === null
          ? t('byPlatform')
          : t('byMember', { name: item.requestedBy.name })}
      </p>
      {notSent ? (
        <p role="status" className="text-amber-700 dark:text-amber-300">
          {reason === null ? t('reason.unknown') : t(`reason.${reason}`)}
        </p>
      ) : null}
      {delivery === null ? null : (
        <p
          className={
            delivery === DeliveryStatus.FAILED ? 'text-amber-700 dark:text-amber-300' : undefined
          }
        >
          {t(`delivery.${delivery}`)}
        </p>
      )}
    </li>
  )
}

// The Messages panel of the order detail (TDD_17 §4.7): what was told to the customer about the order or why it was not, and, for
// who holds orders:send_messages, the preview and the manual send of a message of a kind. One press of "Send" is one key, so a repeated
// press (a double click, a retry after a lost answer) sends once and a new press sends again.
export function OrderMessages({ order }: { order: OrderDetailView }): ReactElement {
  const t = useTranslations('orders.detail.messages')
  const { storeId, can } = useStore()
  const history = useOrderMessageHistory(storeId, order.id)
  const writes = useOrderMessageWrites(storeId, order.id)
  const [kind, setKind] = useState<string>(MANUAL_MESSAGE_KINDS[0] ?? '')
  const kindId = useId()
  // The key of the press in flight: kept after an answer that did not arrive, so pressing again sends once; dropped by any answer and by
  // choosing another kind
  const pressKey = useRef<string | null>(null)
  const maySend = can(ClientPermissions.ORDERS_SEND_MESSAGES)
  const rows = history.data?.pages.flatMap(page => page.data) ?? []
  const preview = writes.preview.data
  const previewReason = preview === undefined || preview.ok ? null : knownReason(preview.reason)
  const busy = writes.send.isPending || writes.preview.isPending

  const pick = (next: string): void => {
    setKind(next)
    pressKey.current = null
    writes.preview.reset()
    writes.send.reset()
  }
  const send = (): void => {
    pressKey.current ??= crypto.randomUUID()
    writes.send.mutate(
      { kind, idempotencyKey: pressKey.current },
      {
        onSuccess: answer => {
          pressKey.current = null
          writes.preview.reset()
          const reason =
            answer.reason === undefined || answer.reason === null ? null : answer.reason
          if (answer.status === OrderMessageOutcomeStatus.NOT_SENT) {
            const known = reason === null ? null : knownReason(reason)
            toast.error(
              t('sendNotSent', {
                reason: known === null ? t('reason.unknown') : t(`reason.${known}`)
              })
            )
          } else if (answer.status === OrderMessageOutcomeStatus.DUPLICATE) {
            toast.success(t('sendDuplicate'))
          } else {
            toast.success(t('sendDone'))
          }
        }
      }
    )
  }

  return (
    <section aria-labelledby="order-messages-heading" className="flex flex-col gap-2">
      <h2 id="order-messages-heading" className="text-base font-semibold">
        {t('heading')}
      </h2>
      {maySend ? (
        <div className="flex flex-col gap-2 rounded border p-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={kindId}>{t('kindLabel')}</Label>
            <select
              id={kindId}
              className={SELECT_CLASS}
              value={kind}
              onChange={event => pick(event.target.value)}
            >
              {MANUAL_MESSAGE_KINDS.map(option => (
                <option key={option} value={option}>
                  {t(`kind.${option}`)}
                </option>
              ))}
            </select>
          </div>
          {preview === undefined ? null : preview.ok ? (
            <p className="bg-muted/40 rounded p-2 text-sm whitespace-pre-wrap" role="status">
              {preview.text}
            </p>
          ) : (
            <p role="status" className="text-amber-700 dark:text-amber-300">
              {previewReason === null ? t('reason.unknown') : t(`reason.${previewReason}`)}
              {preview.missing.length === 0 ? '' : ` (${preview.missing.join(', ')})`}
            </p>
          )}
          <MutationError error={writes.preview.error ?? writes.send.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || kind === ''}
              onClick={() => writes.preview.mutate(kind)}
            >
              <Eye aria-hidden />
              {t('preview')}
            </Button>
            <Button
              type="button"
              size="sm"
              busy={writes.send.isPending}
              disabled={busy || kind === ''}
              onClick={send}
            >
              <Send aria-hidden />
              {t('send')}
            </Button>
          </div>
        </div>
      ) : null}
      {history.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      ) : history.isError ? (
        <p role="alert" className="text-sm">
          {t('failed')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(item => (
            <HistoryRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {history.hasNextPage ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          busy={history.isFetchingNextPage}
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </section>
  )
}
