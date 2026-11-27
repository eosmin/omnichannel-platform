'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FiscalDeliveryView, FiscalDocumentView } from '@platform/api-client'
import {
  FiscalDeliveryPending,
  FiscalDeliveryReason,
  FiscalDeliveryRoute,
  FiscalDeliveryStatus,
  FiscalHandMeans
} from '@platform/core/domain'

import { handOverMeansOf } from '../../lib/fiscal/document-rules'
import { useHandOverFiscalDelivery } from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

const REASONS: readonly string[] = Object.values(FiscalDeliveryReason)

// How the files of an accepted document reached its customer, and, when the system could not give them, the
// way a person does: download the two files above, give them to the customer (or print the representation, at the customer's request) and
// record it. The panel of the store is not a delivery by itself: a row that was not sent stays open until a person records the hand over. There
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
  const format = useFormatter()
  const errorText = useFiscalErrorText()
  const { storeId } = useStore()
  const handOver = useHandOverFiscalDelivery(storeId)
  const available = handOverMeansOf(delivery, true)
  const record = (means: FiscalHandMeans): void =>
    handOver.mutate({ id: document.id, body: { means } })
  const reason =
    delivery.reason !== null && REASONS.includes(delivery.reason)
      ? t(`reasons.${delivery.reason as FiscalDeliveryReason}`)
      : null
  return (
    <section className="flex flex-col gap-2" aria-label={t('title')} data-testid="fiscal-delivery">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      <p className="text-muted-foreground text-xs">{t('description')}</p>
      <p className="text-sm" data-testid="fiscal-delivery-state">
        {delivery.state === FiscalDeliveryPending
          ? t('state.pending')
          : delivery.route === FiscalDeliveryRoute.MANUAL
            ? t('state.manual', {
                means: t(`means.${delivery.means ?? FiscalHandMeans.DOWNLOAD}`),
                date: format.dateTime(new Date(delivery.handedOverAt ?? Date.now()), {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })
              })
            : delivery.state === FiscalDeliveryStatus.SENT
              ? t(`state.${delivery.route ?? FiscalDeliveryRoute.CHANNEL}`)
              : t('state.none')}
      </p>
      {reason !== null && delivery.route !== FiscalDeliveryRoute.CHANNEL ? (
        <p className="text-muted-foreground text-xs">{reason}</p>
      ) : null}
      {available.length > 0 && canManage ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">{t('howTo')}</p>
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
                data-testid={`fiscal-delivery-handed-${item}`}
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
