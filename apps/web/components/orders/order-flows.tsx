'use client'

import { Ban, Check, CircleCheck, PackageCheck, PackageOpen, Truck, Undo2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useId, useState } from 'react'

import type { OrderDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  OrderCancellationReasons,
  OrderConfirmationChannel,
  OrderLimits,
  OrderStatus
} from '@platform/core/domain'

import {
  type FlowOffer,
  type OrderFlow,
  OrderFlows,
  offeredFlows
} from '../../lib/orders/order-detail-rules'
import type { OrderWrites, UploadedOrderFile } from '../../lib/orders/use-order'
import { toast } from '../../lib/toast'
import { useProfile } from '../../lib/use-profile'
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
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

import { OrderFilePicker } from './order-file-picker'

const ICONS = {
  [OrderFlows.CONFIRM]: CircleCheck,
  [OrderFlows.PREPARE]: PackageOpen,
  [OrderFlows.SHIP]: Truck,
  [OrderFlows.DELIVER]: PackageCheck,
  [OrderFlows.RETURN]: Undo2,
  [OrderFlows.CANCEL]: Ban,
  [OrderFlows.APPROVE_PRICE]: Check,
  [OrderFlows.REJECT_PRICE]: X
} as const satisfies Record<OrderFlow, unknown>

// How the customer confirmed: the ones a person can pick (confirming at creation is done when the order is made)
const CONFIRM_CHANNELS = Object.values(OrderConfirmationChannel).filter(
  channel => channel !== OrderConfirmationChannel.AT_CREATION
)
const FACTORY_REASONS = Object.values(OrderCancellationReasons)
// The one that asks the person to write the reason
const OTHER_REASON = OrderCancellationReasons.OTHER

// The buttons of the status flows of an order and the dialog each one opens. The offer comes from the rules of the api
// (`offeredFlows`); a button waiting for a price approval is drawn disabled and says why. The result of a flow is the order
// as it is now, which the page draws (the writes put it in the cache).
export function OrderFlowButtons({
  order,
  writes
}: {
  order: OrderDetailView
  writes: OrderWrites
}): ReactElement | null {
  const t = useTranslations('orders.detail.flows')
  const { can } = useStore()
  const profile = useProfile()
  const [open, setOpen] = useState<OrderFlow | null>(null)
  const hintId = useId()
  const offers = offeredFlows(order, can, profile.data?.id ?? null)
  if (offers.length === 0) return null
  const waiting = offers.some(offer => offer.blockedBy === 'price_approval')
  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label={t('groupLabel')} className="flex flex-wrap gap-2">
        {offers.map(offer => (
          <FlowButton
            key={offer.flow}
            offer={offer}
            hintId={hintId}
            onOpen={() => {
              // A refusal of an earlier try is not this one's
              writes.status.reset()
              writes.confirm.reset()
              writes.cancel.reset()
              writes.decidePrice.reset()
              setOpen(offer.flow)
            }}
          />
        ))}
      </div>
      {waiting ? (
        <p id={hintId} className="text-xs text-amber-700 dark:text-amber-300">
          {t('waitingForPrice')}
        </p>
      ) : null}
      {open !== null ? (
        <FlowDialog flow={open} order={order} writes={writes} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  )
}

function FlowButton({
  offer,
  hintId,
  onOpen
}: {
  offer: FlowOffer
  hintId: string
  onOpen: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.flows')
  const Icon = ICONS[offer.flow]
  const risky = offer.flow === OrderFlows.CANCEL || offer.flow === OrderFlows.REJECT_PRICE
  return (
    <Button
      type="button"
      variant={risky ? 'outline' : 'default'}
      size="sm"
      disabled={offer.disabled}
      aria-describedby={offer.disabled ? hintId : undefined}
      onClick={onOpen}
    >
      <Icon aria-hidden />
      {t(`${offer.flow}.button`)}
    </Button>
  )
}

function FlowDialog({
  flow,
  order,
  writes,
  onClose
}: {
  flow: OrderFlow
  order: OrderDetailView
  writes: OrderWrites
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.flows')
  const tAll = useTranslations()
  const { can } = useStore()
  const [via, setVia] = useState<string>('')
  const [reasonKey, setReasonKey] = useState<string>(OrderCancellationReasons.CUSTOMER_REQUEST)
  const [reasonText, setReasonText] = useState('')
  const [decisionReason, setDecisionReason] = useState('')
  const [proof, setProof] = useState<UploadedOrderFile | null>(null)
  const [restock, setRestock] = useState(false)
  const [uploading, setUploading] = useState(false)
  const reasonId = useId()
  const viaId = useId()
  const mayRestock = can(ClientPermissions.INVENTORY_ADJUST)

  // The mutation of the flow, so the dialog reads its state (pending, refused) from one place
  const mutation =
    flow === OrderFlows.CONFIRM
      ? writes.confirm
      : flow === OrderFlows.CANCEL
        ? writes.cancel
        : flow === OrderFlows.APPROVE_PRICE || flow === OrderFlows.REJECT_PRICE
          ? writes.decidePrice
          : writes.status
  const pending = mutation.isPending

  const cancelReason = reasonKey === OTHER_REASON ? reasonText.trim() : reasonKey
  const missingReason = flow === OrderFlows.CANCEL && cancelReason === ''
  // How the customer confirmed is audit data: nobody gets a default they did not choose
  const missingVia = flow === OrderFlows.CONFIRM && via === ''

  const done = (): void => {
    toast.success(t(`${flow}.done`))
    onClose()
  }
  const submit = (): void => {
    const options = { onSuccess: done }
    switch (flow) {
      case OrderFlows.CONFIRM:
        writes.confirm.mutate(via, options)
        return
      case OrderFlows.PREPARE:
        writes.status.mutate({ status: OrderStatus.PREPARING }, options)
        return
      case OrderFlows.SHIP:
        writes.status.mutate({ status: OrderStatus.SHIPPED }, options)
        return
      case OrderFlows.DELIVER:
        writes.status.mutate(
          {
            status: OrderStatus.DELIVERED,
            ...(proof === null ? {} : { proofOfDeliveryMediaId: proof.mediaId })
          },
          options
        )
        return
      case OrderFlows.RETURN:
        writes.status.mutate(
          { status: OrderStatus.RETURNED, ...(mayRestock ? { restock } : {}) },
          options
        )
        return
      case OrderFlows.CANCEL:
        writes.cancel.mutate(cancelReason, options)
        return
      case OrderFlows.APPROVE_PRICE:
      case OrderFlows.REJECT_PRICE: {
        const reason = decisionReason.trim()
        writes.decidePrice.mutate(
          {
            decision: flow === OrderFlows.APPROVE_PRICE ? 'approve' : 'reject',
            ...(reason === '' ? {} : { reason })
          },
          options
        )
        return
      }
    }
  }

  let body: ReactNode = null
  if (flow === OrderFlows.CONFIRM) {
    body = (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={viaId}>{t('confirm.viaLabel')}</Label>
        <select
          id={viaId}
          className={SELECT_CLASS}
          value={via}
          onChange={event => setVia(event.target.value)}
        >
          <option value="">{t('confirm.viaChoose')}</option>
          {CONFIRM_CHANNELS.map(channel => (
            <option key={channel} value={channel}>
              {t(`confirm.via.${channel}`)}
            </option>
          ))}
        </select>
      </div>
    )
  } else if (flow === OrderFlows.CANCEL) {
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>{t('cancel.reasonLabel')}</Label>
          <select
            id={reasonId}
            className={SELECT_CLASS}
            value={reasonKey}
            onChange={event => setReasonKey(event.target.value)}
          >
            {FACTORY_REASONS.map(key => (
              <option key={key} value={key}>
                {tAll(key as 'orders.cancellationReason.other')}
              </option>
            ))}
          </select>
        </div>
        {reasonKey === OTHER_REASON ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${reasonId}-text`}>{t('cancel.otherLabel')}</Label>
            <Textarea
              id={`${reasonId}-text`}
              rows={3}
              maxLength={OrderLimits.CANCELLATION_REASON_MAX_LENGTH}
              value={reasonText}
              onChange={event => setReasonText(event.target.value)}
            />
          </div>
        ) : null}
      </div>
    )
  } else if (flow === OrderFlows.DELIVER) {
    body = (
      <OrderFilePicker
        orderId={order.id}
        label={t('deliver.proofLabel')}
        value={proof}
        onChange={setProof}
        onBusyChange={setUploading}
      />
    )
  } else if (flow === OrderFlows.RETURN) {
    body = mayRestock ? (
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-current pointer-coarse:size-5"
          checked={restock}
          onChange={event => setRestock(event.target.checked)}
        />
        <span>
          <span className="block font-medium">{t('return.restockLabel')}</span>
          <span className="text-muted-foreground block">{t('return.restockHint')}</span>
        </span>
      </label>
    ) : (
      <p className="text-muted-foreground text-sm">{t('return.noRestockPermission')}</p>
    )
  } else if (flow === OrderFlows.APPROVE_PRICE || flow === OrderFlows.REJECT_PRICE) {
    body = (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={reasonId}>{t('price.reasonLabel')}</Label>
        <Textarea
          id={reasonId}
          rows={3}
          maxLength={OrderLimits.PRICE_REASON_MAX_LENGTH}
          value={decisionReason}
          onChange={event => setDecisionReason(event.target.value)}
        />
      </div>
    )
  }

  return (
    <Dialog open onOpenChange={next => (next || pending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(`${flow}.title`, { number: order.orderNumber })}</DialogTitle>
          <DialogDescription>{t(`${flow}.description`)}</DialogDescription>
        </DialogHeader>
        {body}
        <MutationError error={mutation.error} />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {tAll('common.cancel')}
          </Button>
          <Button
            type="button"
            variant={
              flow === OrderFlows.CANCEL || flow === OrderFlows.REJECT_PRICE
                ? 'destructive'
                : 'default'
            }
            disabled={pending || missingReason || missingVia || uploading}
            busy={pending}
            onClick={submit}
          >
            {t(`${flow}.confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
