'use client'

import { Loader2, Printer, Send, Truck, Check, X, Tag } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { OrderConfirmationChannel } from '@platform/core/domain'

import { SELECT_CLASS } from '../../components/ui/field-classes'
import {
  type BulkActionKind,
  BulkActionKinds,
  type BulkAvailability,
  type BulkConnection,
  canMakeGuides,
  offersCarrierChoice,
  placesConnectionOf
} from '../../lib/orders/order-bulk'
import type { OrderBulk } from '../../lib/orders/use-order-bulk'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Label } from '../ui/label'

import { GuideLocationSelects } from './order-guide-locations'

// The ways to confirm that a person can pick: the creation is not one of them
const CONFIRM_CHANNELS = Object.values(OrderConfirmationChannel).filter(
  channel => channel !== OrderConfirmationChannel.AT_CREATION
)

function ConfirmDialog({
  count,
  open,
  busy,
  onClose,
  onConfirm
}: {
  count: number
  open: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (via: string) => void
}): ReactElement {
  const t = useTranslations('orders.bulk.confirm')
  const [via, setVia] = useState('')
  return (
    <Dialog open={open} onOpenChange={next => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { count })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="orders-bulk-via">{t('viaLabel')}</Label>
          <select
            id="orders-bulk-via"
            className={SELECT_CLASS}
            value={via}
            onChange={event => setVia(event.target.value)}
          >
            <option value="">{t('viaChoose')}</option>
            {CONFIRM_CHANNELS.map(channel => (
              <option key={channel} value={channel}>
                {t(`via.${channel}`)}
              </option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button disabled={via === '' || busy} busy={busy} onClick={() => onConfirm(via)}>
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The actions over the rows ticked on the orders page (Step 4.14): each shows only when the member holds its permission and
// there is something to act on, and the server judges every order. What it did is the report beside it.
export function OrderBulkBar({
  storeId,
  bulk,
  availability,
  selectedCount,
  connections,
  onClear
}: {
  storeId: string
  bulk: OrderBulk
  availability: BulkAvailability
  selectedCount: number
  connections: readonly BulkConnection[]
  onClear: () => void
}): ReactElement {
  const t = useTranslations('orders.bulk')
  const [confirming, setConfirming] = useState(false)
  const [connectionId, setConnectionId] = useState('')
  const [places, setPlaces] = useState({ departmentId: '', municipalityId: '' })
  // The places are asked once for the whole run, when the carrier it goes to declares that it needs them
  const placesConnection = placesConnectionOf(connections, connectionId)
  const pinnable = connections.filter(canMakeGuides)
  const isBusy = bulk.busy !== null
  const running = (kind: BulkActionKind): boolean => bulk.busy === kind
  const percent = bulk.progress === null ? null : Math.round(bulk.progress * 100)

  return (
    <div
      role="region"
      aria-label={t('label')}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span role="status">{t('selected', { count: selectedCount })}</span>
      {availability.confirm ? (
        <Button size="sm" variant="outline" disabled={isBusy} onClick={() => setConfirming(true)}>
          <Check aria-hidden />
          {t('confirm.button')}
        </Button>
      ) : null}
      {availability.summary ? (
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          busy={running(BulkActionKinds.SUMMARY)}
          onClick={() => void bulk.summary()}
        >
          <Send aria-hidden />
          {t('summary')}
        </Button>
      ) : null}
      {availability.labels ? (
        <>
          {offersCarrierChoice(connections) ? (
            <>
              <Label htmlFor="orders-bulk-carrier" className="sr-only">
                {t('carrierLabel')}
              </Label>
              <select
                id="orders-bulk-carrier"
                className={SELECT_CLASS}
                value={connectionId}
                disabled={isBusy}
                onChange={event => {
                  setConnectionId(event.target.value)
                  setPlaces({ departmentId: '', municipalityId: '' })
                }}
              >
                <option value="">{t('plannedCarrier')}</option>
                {pinnable.map(connection => (
                  <option key={connection.id} value={connection.id}>
                    {connection.displayName}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {placesConnection === null ? null : (
            <div className="w-full">
              <GuideLocationSelects
                namespace="orders.bulk.places"
                key={placesConnection.id}
                id="orders-bulk-places"
                storeId={storeId}
                connectionId={placesConnection.id}
                departmentId={places.departmentId}
                municipalityId={places.municipalityId}
                onChange={setPlaces}
              />
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy || (placesConnection !== null && places.municipalityId === '')}
            busy={running(BulkActionKinds.LABELS)}
            onClick={() =>
              void (placesConnection === null
                ? bulk.labels(connectionId === '' ? undefined : connectionId)
                : bulk.labels(placesConnection.id, places))
            }
          >
            <Tag aria-hidden />
            {t('labels')}
          </Button>
        </>
      ) : null}
      {availability.print ? (
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          busy={running(BulkActionKinds.PRINT)}
          onClick={() => void bulk.print()}
        >
          <Printer aria-hidden />
          {t('print')}
        </Button>
      ) : null}
      {availability.pickup ? (
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          busy={running(BulkActionKinds.PICKUP)}
          onClick={() => void bulk.pickup()}
        >
          <Truck aria-hidden />
          {t('pickup')}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" disabled={isBusy} onClick={onClear}>
        <X aria-hidden />
        {t('clear')}
      </Button>
      {availability.tooMany ? (
        <p role="alert" className="w-full text-amber-700 dark:text-amber-300">
          {t('tooMany')}
        </p>
      ) : null}
      {isBusy ? (
        <p role="status" className="text-muted-foreground flex w-full items-center gap-2">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          {percent === null ? t('running') : t('runningProgress', { percent })}
        </p>
      ) : null}
      <ConfirmDialog
        key={confirming ? 'open' : 'closed'}
        count={selectedCount}
        open={confirming}
        busy={running(BulkActionKinds.CONFIRM)}
        onClose={() => setConfirming(false)}
        onConfirm={via => {
          setConfirming(false)
          void bulk.confirm(via)
        }}
      />
    </div>
  )
}
