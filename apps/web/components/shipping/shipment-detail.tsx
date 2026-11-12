'use client'

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type ShipmentEventView, type ShipmentRowView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { ShipmentEventNotes, ShipmentEventSource, ShipmentStatus } from '@platform/core/domain'

import { isKnown } from '../../lib/shipping/known-value'
import { guideActions } from '../../lib/shipping/shipping-rules'
import {
  useCheckShipment,
  useShipmentDetail,
  useShipmentLabel
} from '../../lib/shipping/use-shipping-screens'
import { toast } from '../../lib/toast'
import { useCodeText, useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'

import {
  ShipmentConfirmDialog,
  type ShipmentDialogKind,
  ShipmentSettleDialog
} from './shipment-action-dialogs'
import { ShipmentStatusText } from './shipment-status-text'

function EventLine({ event }: { event: ShipmentEventView }): ReactElement {
  const t = useTranslations('shipments.detail')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const when = new Date(event.occurredAt)
  // A carrier status that no mapping knows: only the carrier's own code is shown (its description can carry a name or an address)
  const isUnmapped = event.status === null && event.rawStatus !== null
  const note = event.description
  return (
    <li className="flex flex-col gap-0.5 border-b py-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {event.status !== null ? (
            <ShipmentStatusText status={event.status} />
          ) : (
            (event.rawStatus ?? t('eventNoStatus'))
          )}
        </span>
        <span className="text-muted-foreground text-xs">
          {Number.isNaN(when.getTime())
            ? ''
            : format.dateTime(when, { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      </div>
      <span className="text-muted-foreground text-xs">
        {isKnown(ShipmentEventSource, event.source)
          ? t(`source.${event.source}` as 'source.manual')
          : t('source.system')}
      </span>
      {isUnmapped ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t('unmapped')}{' '}
          {can(ClientPermissions.SETTINGS_MANAGE_CARRIERS) ? (
            <Link
              href={AppPaths.store.settings(storeId, 'carriers')}
              className="underline underline-offset-2"
            >
              {t('mapIt')}
            </Link>
          ) : null}
        </p>
      ) : null}
      {note !== null && isKnown(ShipmentEventNotes, note) ? (
        <span className="text-xs">{t(`note.${note}` as 'note.shipping.event.foundAtCarrier')}</span>
      ) : null}
    </li>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: ReactElement | string
}): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

// One guide: its data, its history and what the person may do with it
export function ShipmentDetail({
  shipmentId,
  capabilitiesOf,
  onClose
}: {
  shipmentId: string
  capabilitiesOf: (connectionId: string) => readonly string[] | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('shipments.detail')
  const format = useFormatter()
  const errorText = useErrorText()
  const codeText = useCodeText()
  const { storeId, can } = useStore()
  const detail = useShipmentDetail(storeId, shipmentId)
  const label = useShipmentLabel(storeId)
  const check = useCheckShipment(storeId)
  const [dialog, setDialog] = useState<ShipmentDialogKind | null>(null)
  const shipment = detail.data
  const actions =
    shipment === undefined
      ? null
      : guideActions(shipment, {
          canManage: can(ClientPermissions.SHIPPING_MANAGE),
          canManagePickups: can(ClientPermissions.SHIPPING_MANAGE_PICKUPS),
          capabilities: capabilitiesOf(shipment.connectionId)
        })

  const printLabel = (): void =>
    label.mutate(shipmentId, {
      onSuccess: link => {
        // An anchor, not `window.open(..., 'noopener')`, which always answers null and cannot tell a blocked popup from success
        const anchor = document.createElement('a')
        anchor.href = link.url
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
        anchor.click()
      },
      onError: error => toast.error(errorText(error))
    })
  const askCarrier = (): void =>
    check.mutate(shipmentId, {
      onSuccess: result => toast.info(t(result.found ? 'checkFound' : 'checkNotFound')),
      onError: error => toast.error(errorText(error))
    })
  const day = (iso: string | null): string => {
    if (iso === null) return ''
    const date = new Date(iso)
    return Number.isNaN(date.getTime())
      ? ''
      : format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' })
  }

  return (
    <Sheet open onOpenChange={next => (next ? undefined : onClose())}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('title', { guide: shipment?.guideNumber ?? t('noGuide') })}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {detail.isPending ? <PageLoading /> : null}
          {detail.isError ? (
            <LoadFailed error={detail.error} onRetry={() => void detail.refetch()} />
          ) : null}
          {shipment === undefined || actions === null ? null : (
            <>
              <div className="flex flex-wrap gap-2">
                {actions.label ? (
                  <Button variant="outline" size="sm" busy={label.isPending} onClick={printLabel}>
                    {t('actions.label')}
                  </Button>
                ) : null}
                {actions.check ? (
                  <Button variant="outline" size="sm" busy={check.isPending} onClick={askCarrier}>
                    {t('actions.check')}
                  </Button>
                ) : null}
                {actions.settle ? (
                  <Button variant="outline" size="sm" onClick={() => setDialog('settle')}>
                    {t('actions.settle')}
                  </Button>
                ) : null}
                {actions.markVoided ? (
                  <Button variant="outline" size="sm" onClick={() => setDialog('markVoided')}>
                    {t('actions.markVoided')}
                  </Button>
                ) : null}
                {actions.cancel ? (
                  <Button variant="outline" size="sm" onClick={() => setDialog('cancel')}>
                    {t('actions.cancel')}
                  </Button>
                ) : null}
              </div>
              {shipment.status === String(ShipmentStatus.REQUIRES_REVIEW) ? (
                <p role="note" className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  {t('requiresReview')}
                </p>
              ) : null}
              {shipment.status === String(ShipmentStatus.CANCEL_FAILED) ? (
                <p role="note" className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  {t('cancelFailed')}
                </p>
              ) : null}
              {shipment.lastError === null ? null : (
                <p role="note" className="text-sm">
                  {t('lastError', { error: codeText(shipment.lastError) })}
                </p>
              )}
              <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Field label={t('fields.status')}>
                  <ShipmentStatusText status={shipment.status} />
                </Field>
                <Field label={t('fields.carrier')}>{shipment.connectionName}</Field>
                <Field label={t('fields.order')}>
                  <Link
                    href={AppPaths.store.order(storeId, shipment.orderId)}
                    className="underline underline-offset-2"
                  >
                    {t('orderNumber', { number: shipment.orderNumber })}
                  </Link>
                </Field>
                <Field label={t('fields.guide')}>
                  {shipment.guideNumber === null ? (
                    t('noGuide')
                  ) : shipment.trackingUrl === null ? (
                    shipment.guideNumber
                  ) : (
                    <a
                      href={shipment.trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      {shipment.guideNumber}
                    </a>
                  )}
                </Field>
                <Field label={t('fields.created')}>{day(shipment.createdAt)}</Field>
                <Field label={t('fields.packages')}>{String(shipment.packageCount)}</Field>
                <Field label={t('fields.failedAttempts')}>{String(shipment.failedAttempts)}</Field>
              </dl>
              <section aria-labelledby="shipment-history">
                <h3 id="shipment-history" className="text-sm font-semibold">
                  {t('history')}
                </h3>
                {shipment.events.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('noEvents')}</p>
                ) : (
                  <ul>
                    {shipment.events.map(event => (
                      <EventLine key={event.id} event={event} />
                    ))}
                  </ul>
                )}
              </section>
              {dialog === 'cancel' || dialog === 'markVoided' ? (
                <ShipmentConfirmDialog
                  kind={dialog}
                  storeId={storeId}
                  shipment={shipment}
                  open
                  isLocalOnly={actions.cancelIsLocalOnly}
                  onOpenChange={open => (open ? undefined : setDialog(null))}
                />
              ) : null}
              {dialog === 'settle' ? (
                <ShipmentSettleDialog
                  storeId={storeId}
                  shipment={shipment}
                  open
                  isLocalOnly={false}
                  onOpenChange={open => (open ? undefined : setDialog(null))}
                />
              ) : null}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export type { ShipmentRowView }
