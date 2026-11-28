'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FiscalDeliveryView, FiscalDocumentView } from '@platform/api-client'
import {
  FiscalDeliveryPending,
  FiscalDeliveryReason,
  FiscalDeliveryRoute,
  FiscalDeliveryStatus,
  FiscalDeliverySubject,
  FiscalHandMeans
} from '@platform/core/domain'

import { handOverMeansOf } from '../../lib/fiscal/document-rules'
import { useHandOverFiscalDelivery } from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

const REASONS: readonly string[] = Object.values(FiscalDeliveryReason)

// How the files of an accepted document, or of its invalidation (`delivery.subject`), reached its customer, and, when the system could not give
// them, the way a person does: download the two files above, give them to the customer (or print the representation, at the customer's request)
// and record it. An invalidation with no event of ours to give is handed over as the answer of the authority, with its code and seal. The panel of the store is not a delivery by itself: a row that was not sent stays open until a person records the hand over. There
// is no public link: the files are the ones of the evidence, behind the permission to read the documents.
export function HandDelivery({
  document,
  delivery,
  canManage
}: {
  document: FiscalDocumentView
  delivery: FiscalDeliveryView
  canManage: boolean
}): ReactElement {
  const t = useTranslations('finance.fiscal.delivery')
  // The wording of the invalidation is its own: it names the invalidation and the answer of the authority
  const voided = delivery.subject === FiscalDeliverySubject.VOID
  const text = (key: string, values?: Record<string, string>): string =>
    t(`${voided ? 'void.' : ''}${key}` as never, values as never)
  const format = useFormatter()
  const errorText = useFiscalErrorText()
  const { storeId } = useStore()
  const handOver = useHandOverFiscalDelivery(storeId)
  const available = handOverMeansOf(delivery, true)
  const record = (means: FiscalHandMeans): void =>
    handOver.mutate({ id: document.id, body: { means, subject: delivery.subject } })
  const reason =
    delivery.reason !== null && REASONS.includes(delivery.reason)
      ? t(`reasons.${delivery.reason as FiscalDeliveryReason}`)
      : null
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={text('title')}
      data-testid={`fiscal-delivery-${delivery.subject}`}
    >
      <h3 className="text-sm font-semibold">{text('title')}</h3>
      <p className="text-muted-foreground text-xs">{text('description')}</p>
      <p className="text-sm" data-testid={`fiscal-delivery-${delivery.subject}-state`}>
        {delivery.state === FiscalDeliveryPending
          ? text('state.pending')
          : delivery.route === FiscalDeliveryRoute.MANUAL
            ? text('state.manual', {
                means: t(`means.${delivery.means ?? FiscalHandMeans.DOWNLOAD}`),
                date: format.dateTime(new Date(delivery.handedOverAt ?? Date.now()), {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })
              })
            : delivery.state === FiscalDeliveryStatus.SENT
              ? text(`state.${delivery.route ?? FiscalDeliveryRoute.CHANNEL}`)
              : text('state.none')}
      </p>
      {reason !== null && delivery.route !== FiscalDeliveryRoute.CHANNEL ? (
        <p className="text-muted-foreground text-xs">{reason}</p>
      ) : null}
      {available.length > 0 && canManage ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">{text('howTo')}</p>
          <div className="flex flex-wrap gap-2">
            {available.map(item => (
              <Button
                key={item}
                type="button"
                variant="outline"
                size="sm"
                disabled={handOver.isPending}
                busy={handOver.isPending}
                onClick={() => record(item)}
                data-testid={`fiscal-delivery-${delivery.subject}-handed-${item}`}
              >
                {t(`handed.${item}`)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {handOver.isError ? (
        <p role="alert" className="text-destructive text-xs">
          {errorText(handOver.error)}
        </p>
      ) : null}
    </section>
  )
}
