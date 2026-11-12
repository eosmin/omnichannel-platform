'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { CarrierConnectionView, OrderDetailView, ReturnView } from '@platform/api-client'
import { ShipmentLimits, ShippingPayer } from '@platform/core/domain'

import {
  activeServices,
  codPreview,
  connectionsNeedingLocations,
  defaultConnection,
  guideBody,
  type GuideConnection,
  guideConnections,
  initialDraft,
  needsPickup,
  pickupOf,
  returnGuideBody,
  returnGuideConnections
} from '../../lib/orders/order-guide-form'
import type { ShipmentWrites } from '../../lib/orders/use-order-guides'
import type { ReturnWrites } from '../../lib/orders/use-order-returns'
import { formatCents } from '../../lib/products/money'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

import type { WarehouseOption } from './order-return-dialogs'

function ConnectionSelect({
  id,
  connections,
  value,
  onChange
}: {
  id: string
  connections: readonly GuideConnection[]
  value: string
  onChange: (connectionId: string) => void
}): ReactElement {
  const t = useTranslations('orders.detail.guide')
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t('connectionLabel')}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        {connections.map(connection => (
          <option key={connection.id} value={connection.id}>
            {connection.displayName}
          </option>
        ))}
      </select>
    </div>
  )
}

function ServiceSelect({
  id,
  connection,
  value,
  onChange
}: {
  id: string
  connection: GuideConnection
  value: string
  onChange: (code: string) => void
}): ReactElement | null {
  const t = useTranslations('orders.detail.guide')
  const services = activeServices(connection)
  if (services.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t('serviceLabel')}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        {services.map(service => (
          <option key={service.code} value={service.code}>
            {service.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function NoConnection({ hidden, onClose }: { hidden: number; onClose: () => void }): ReactElement {
  const t = useTranslations('orders.detail.guide')
  const tAll = useTranslations()
  return (
    <>
      <p role="status" className="text-sm">
        {hidden > 0 ? t('onlyWithLocations', { count: hidden }) : t('noConnection')}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tAll('common.close')}
        </Button>
      </DialogFooter>
    </>
  )
}

// Makes the guide of an order (`POST /orders/:id/shipments`): the connection (the store's default to start), its service and the
// payer (the sender for a free-shipping order), the amount the carrier collects (read-only: it is the order's, and the api writes it)
// and, for a carrier whose guides live in a pickup, the day and window of that pickup. What it offers is read from the capabilities
// of the connections; a carrier that asks for the ids of the places is not offered until the lookup of its adapter exists.
export function CreateGuideDialog({
  order,
  connections,
  writes,
  onClose
}: {
  order: OrderDetailView
  connections: readonly CarrierConnectionView[]
  writes: ShipmentWrites
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.guide')
  const tAll = useTranslations()
  const format = useFormatter()
  const id = useId()
  const usable = guideConnections(connections)
  const hidden = connectionsNeedingLocations(connections)
  const [draft, setDraft] = useState(() =>
    initialDraft(defaultConnection(usable), order.freeShipping)
  )
  const connection = usable.find(entry => entry.id === draft.connectionId)
  const body = guideBody(draft, connection, order.freeShipping)
  const cod = codPreview(order)
  const pickupBad = connection !== undefined && needsPickup(connection) && pickupOf(draft) === null
  const mutation = writes.create
  return (
    <Dialog open onOpenChange={next => (next || mutation.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { number: order.orderNumber })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {connection === undefined ? (
          <NoConnection hidden={hidden} onClose={onClose} />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <ConnectionSelect
                id={`${id}-connection`}
                connections={usable}
                value={draft.connectionId}
                onChange={connectionId =>
                  setDraft({
                    ...initialDraft(
                      usable.find(entry => entry.id === connectionId),
                      order.freeShipping
                    ),
                    notes: draft.notes
                  })
                }
              />
              <ServiceSelect
                id={`${id}-service`}
                connection={connection}
                value={draft.serviceCode}
                onChange={serviceCode => setDraft({ ...draft, serviceCode })}
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-payer`}>{t('payerLabel')}</Label>
                <select
                  id={`${id}-payer`}
                  className={SELECT_CLASS}
                  value={draft.payer}
                  disabled={order.freeShipping}
                  onChange={event =>
                    setDraft({ ...draft, payer: event.target.value as ShippingPayer })
                  }
                >
                  {Object.values(ShippingPayer).map(payer => (
                    <option key={payer} value={payer}>
                      {tAll(`orders.detail.returns.payer.${payer}`)}
                    </option>
                  ))}
                </select>
                {order.freeShipping ? (
                  <p className="text-muted-foreground text-xs">{t('payerFreeShipping')}</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t('codLabel')}</span>
                <p className="text-sm">
                  {cod.collects ? formatCents(format, cod.amountCents) : t('codNone')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {cod.collects ? t('codReasonCollects') : t('codReasonPrepaid')}
                </p>
              </div>
              {needsPickup(connection) ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-medium">{t('pickupLegend')}</legend>
                  <p className="text-muted-foreground text-xs">{t('pickupHint')}</p>
                  <div className="flex flex-wrap gap-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-date`}>{t('pickupDate')}</Label>
                      <Input
                        id={`${id}-date`}
                        type="date"
                        value={draft.pickupDate}
                        aria-invalid={pickupBad}
                        onChange={event => setDraft({ ...draft, pickupDate: event.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-from`}>{t('pickupFrom')}</Label>
                      <Input
                        id={`${id}-from`}
                        type="time"
                        value={draft.pickupFrom}
                        aria-invalid={pickupBad}
                        onChange={event => setDraft({ ...draft, pickupFrom: event.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-to`}>{t('pickupTo')}</Label>
                      <Input
                        id={`${id}-to`}
                        type="time"
                        value={draft.pickupTo}
                        aria-invalid={pickupBad}
                        onChange={event => setDraft({ ...draft, pickupTo: event.target.value })}
                      />
                    </div>
                  </div>
                  {pickupBad ? (
                    <p role="alert" className="text-destructive text-xs">
                      {t('pickupInvalid')}
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-notes`}>{t('notesLabel')}</Label>
                <Textarea
                  id={`${id}-notes`}
                  rows={2}
                  maxLength={ShipmentLimits.NOTES_MAX_LENGTH}
                  value={draft.notes}
                  onChange={event => setDraft({ ...draft, notes: event.target.value })}
                />
                <p className="text-muted-foreground text-xs">{t('notesHint')}</p>
              </div>
            </div>
            <MutationError error={mutation.error} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={onClose}
              >
                {tAll('common.cancel')}
              </Button>
              <Button
                type="button"
                disabled={mutation.isPending || body === null}
                busy={mutation.isPending}
                onClick={() => {
                  if (body === null) return
                  mutation.mutate(body, {
                    onSuccess: () => {
                      toast.success(t('done'))
                      onClose()
                    }
                  })
                }}
              >
                {t('confirm')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// The guide of the way back of an approved return (`POST /returns/:id/return-shipment`): a connection whose carrier declares it,
// its service and the warehouse the goods go to (the one that sent most of them when none is chosen). The payer is the return's
// and the guide is never cash on delivery.
export function ReturnGuideDialog({
  returnView,
  connections,
  warehouses,
  writes,
  onClose
}: {
  returnView: ReturnView
  connections: readonly CarrierConnectionView[]
  warehouses: readonly WarehouseOption[]
  writes: ReturnWrites
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.guide')
  const tAll = useTranslations()
  const id = useId()
  const usable = returnGuideConnections(connections)
  const first = defaultConnection(usable)
  const [connectionId, setConnectionId] = useState(first?.id ?? '')
  const [serviceCode, setServiceCode] = useState(() =>
    first === undefined ? '' : initialDraft(first, false).serviceCode
  )
  const [warehouseId, setWarehouseId] = useState('')
  const [notes, setNotes] = useState('')
  const connection = usable.find(entry => entry.id === connectionId)
  const body = returnGuideBody({ connectionId, serviceCode, warehouseId, notes })
  const mutation = writes.returnGuide
  return (
    <Dialog open onOpenChange={next => (next || mutation.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('returnTitle')}</DialogTitle>
          <DialogDescription>{t('returnDescription')}</DialogDescription>
        </DialogHeader>
        {connection === undefined ? (
          <NoConnection hidden={0} onClose={onClose} />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <ConnectionSelect
                id={`${id}-connection`}
                connections={usable}
                value={connectionId}
                onChange={next => {
                  setConnectionId(next)
                  const chosen = usable.find(entry => entry.id === next)
                  setServiceCode(
                    chosen === undefined ? '' : initialDraft(chosen, false).serviceCode
                  )
                }}
              />
              <ServiceSelect
                id={`${id}-service`}
                connection={connection}
                value={serviceCode}
                onChange={setServiceCode}
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-warehouse`}>{t('warehouseLabel')}</Label>
                <select
                  id={`${id}-warehouse`}
                  className={SELECT_CLASS}
                  value={warehouseId}
                  onChange={event => setWarehouseId(event.target.value)}
                >
                  <option value="">{t('warehouseDefault')}</option>
                  {warehouses.map(warehouse => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-muted-foreground text-xs">
                {t('returnPayer', {
                  payer: tAll(`orders.detail.returns.payer.${returnView.shippingPayer}`)
                })}
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-notes`}>{t('notesLabel')}</Label>
                <Textarea
                  id={`${id}-notes`}
                  rows={2}
                  maxLength={ShipmentLimits.NOTES_MAX_LENGTH}
                  value={notes}
                  onChange={event => setNotes(event.target.value)}
                />
              </div>
            </div>
            <MutationError error={mutation.error} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={onClose}
              >
                {tAll('common.cancel')}
              </Button>
              <Button
                type="button"
                disabled={mutation.isPending || body === null}
                busy={mutation.isPending}
                onClick={() => {
                  if (body === null) return
                  mutation.mutate(
                    { returnId: returnView.id, body },
                    {
                      onSuccess: () => {
                        toast.success(t('returnDone'))
                        onClose()
                      }
                    }
                  )
                }}
              >
                {t('returnConfirm')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
