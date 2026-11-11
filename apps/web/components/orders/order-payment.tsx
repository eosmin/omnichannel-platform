'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { OrderDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { OrderLimits, PaymentMethod, PaymentStatus } from '@platform/core/domain'

import {
  asPaymentMethod,
  asPaymentStatus,
  paymentTargets
} from '../../lib/orders/order-detail-rules'
import type { OrderWrites, UploadedOrderFile } from '../../lib/orders/use-order'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
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
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { OrderFileLink } from './order-file-link'
import { OrderFilePicker } from './order-file-picker'

// The methods that should name the number of the transfer or of the voucher when they are taken as paid: the form asks for it
// (the api does not force it: cash has no number)
const METHODS_WITH_REFERENCE: readonly PaymentMethod[] = [
  PaymentMethod.TRANSFER,
  PaymentMethod.CARD
]

// The payment of the order: how it was sold, the state of the money, the reference and the receipt. A payment is recorded by
// hand (v1.2 has no online gateway) and never changes how the order was sold.
export function OrderPayment({
  order,
  writes
}: {
  order: OrderDetailView
  writes: OrderWrites
}): ReactElement {
  const t = useTranslations('orders.detail.payment')
  const tOrders = useTranslations('orders')
  const { can } = useStore()
  const [open, setOpen] = useState(false)
  const method = asPaymentMethod(order.paymentMethod)
  const status = asPaymentStatus(order.paymentStatus)
  const targets = paymentTargets(order)
  const mayRecord = can(ClientPermissions.ORDERS_EDIT) && targets.length > 0
  return (
    <section aria-labelledby="order-payment-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="order-payment-heading" className="text-base font-semibold">
          {t('heading')}
        </h2>
        {mayRecord ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              writes.payment.reset()
              setOpen(true)
            }}
          >
            {t('record')}
          </Button>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('method')}</dt>
        <dd>
          {method === null ? tOrders('list.unknownPayment') : tOrders(`paymentMethod.${method}`)}
        </dd>
        <dt className="text-muted-foreground">{t('status')}</dt>
        <dd>
          {status === null ? tOrders('list.unknownPayment') : tOrders(`paymentStatus.${status}`)}
        </dd>
        <dt className="text-muted-foreground">{t('reference')}</dt>
        <dd>{order.paymentReference ?? t('none')}</dd>
        <dt className="text-muted-foreground">{t('receipt')}</dt>
        <dd>
          {order.paymentProofMediaId === null ? (
            t('none')
          ) : (
            <OrderFileLink mediaId={order.paymentProofMediaId} />
          )}
        </dd>
      </dl>
      {open ? (
        <RecordPaymentDialog order={order} writes={writes} onClose={() => setOpen(false)} />
      ) : null}
    </section>
  )
}

function RecordPaymentDialog({
  order,
  writes,
  onClose
}: {
  order: OrderDetailView
  writes: OrderWrites
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.payment')
  const tOrders = useTranslations('orders')
  const tAll = useTranslations()
  const targets = paymentTargets(order)
  const [method, setMethod] = useState<string>(order.paymentMethod)
  // Starts on the state the payment has: marking money as received is a choice, never the default of a click
  const [status, setStatus] = useState<string>(
    targets.some(target => String(target) === order.paymentStatus)
      ? order.paymentStatus
      : (targets[0] ?? order.paymentStatus)
  )
  const [uploading, setUploading] = useState(false)
  const [reference, setReference] = useState(order.paymentReference ?? '')
  const [receipt, setReceipt] = useState<UploadedOrderFile | null>(null)
  const methodId = useId()
  const statusId = useId()
  const referenceId = useId()
  const pending = writes.payment.isPending
  const known = asPaymentMethod(method)
  const trimmed = reference.trim()
  // A transfer or a card taken as paid should name its number: the form says so and still lets it go (the api does not force it)
  const needsReference =
    asPaymentStatus(status) === PaymentStatus.COMPLETED &&
    known !== null &&
    METHODS_WITH_REFERENCE.includes(known) &&
    trimmed === ''
  const submit = (): void => {
    const asMethod = asPaymentMethod(method)
    const asStatus = asPaymentStatus(status)
    if (asMethod === null || asStatus === null) return
    writes.payment.mutate(
      {
        method: asMethod,
        status: asStatus,
        ...(trimmed === '' ? {} : { reference: trimmed }),
        ...(receipt === null ? {} : { proofMediaId: receipt.mediaId })
      },
      {
        onSuccess: () => {
          toast.success(t('done'))
          onClose()
        }
      }
    )
  }
  return (
    <Dialog open onOpenChange={next => (next || pending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialogTitle', { number: order.orderNumber })}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={methodId}>{t('recordMethod')}</Label>
            <select
              id={methodId}
              className={SELECT_CLASS}
              value={method}
              onChange={event => setMethod(event.target.value)}
            >
              {Object.values(PaymentMethod).map(value => (
                <option key={value} value={value}>
                  {tOrders(`paymentMethod.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={statusId}>{t('recordStatus')}</Label>
            <select
              id={statusId}
              className={SELECT_CLASS}
              value={status}
              onChange={event => setStatus(event.target.value)}
            >
              {targets.map(value => (
                <option key={value} value={value}>
                  {tOrders(`paymentStatus.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={referenceId}>{t('recordReference')}</Label>
            <Input
              id={referenceId}
              value={reference}
              maxLength={OrderLimits.PAYMENT_REFERENCE_MAX_LENGTH}
              aria-describedby={needsReference ? `${referenceId}-hint` : undefined}
              onChange={event => setReference(event.target.value)}
            />
            {needsReference ? (
              <p id={`${referenceId}-hint`} className="text-xs text-amber-700 dark:text-amber-300">
                {t('referenceAsked')}
              </p>
            ) : null}
          </div>
          <OrderFilePicker
            orderId={order.id}
            label={t('recordReceipt')}
            value={receipt}
            onChange={setReceipt}
            onBusyChange={setUploading}
          />
        </div>
        <MutationError error={writes.payment.error} />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {tAll('common.cancel')}
          </Button>
          <Button type="button" disabled={pending || uploading} busy={pending} onClick={submit}>
            {t('recordConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
