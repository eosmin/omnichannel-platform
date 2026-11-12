'use client'

import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { OrderDetailView, ReturnView } from '@platform/api-client'
import {
  OrderReturnCondition,
  OrderReturnReasonKeys,
  OrderReturnType,
  ReturnLimits,
  ShippingPayer
} from '@platform/core/domain'

import {
  approveBody,
  asReturnReasonKey,
  completeBody,
  createReturnBody,
  type CreateReturnDraft,
  EMPTY_RETURN_DRAFT,
  receiveBody,
  type ReceiveLineDraft,
  type ReplacementLineDraft,
  remainingUnits,
  ReturnActions,
  unitsOf
} from '../../lib/orders/order-returns-rules'
import type { ReturnWrites } from '../../lib/orders/use-order-returns'
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

import { OrderProductPicker } from './order-product-picker'

export interface WarehouseOption {
  id: string
  name: string
}

function Footer({
  pending,
  disabled,
  confirmLabel,
  onClose,
  onConfirm
}: {
  pending: boolean
  disabled: boolean
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}): ReactElement {
  const tAll = useTranslations()
  return (
    <DialogFooter>
      <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
        {tAll('common.cancel')}
      </Button>
      <Button type="button" disabled={pending || disabled} busy={pending} onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </DialogFooter>
  )
}

// A new return of the order (`POST /returns`): the units of each item that come back, why, and who pays the way back. The units an
// item has left are what the returns that still hold units leave of it; the api checks them again.
export function CreateReturnDialog({
  order,
  returns,
  writes,
  onClose
}: {
  order: OrderDetailView
  returns: readonly ReturnView[]
  writes: ReturnWrites
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.returns.create')
  const tAll = useTranslations()
  const [draft, setDraft] = useState<CreateReturnDraft>(EMPTY_RETURN_DRAFT)
  const id = useId()
  const left = remainingUnits(order.items, returns)
  const body = createReturnBody(order.id, draft, left)
  const mutation = writes.create
  return (
    <Dialog open onOpenChange={next => (next || mutation.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { number: order.orderNumber })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-type`}>{t('typeLabel')}</Label>
            <select
              id={`${id}-type`}
              className={SELECT_CLASS}
              value={draft.type}
              onChange={event =>
                setDraft({ ...draft, type: event.target.value as OrderReturnType })
              }
            >
              {Object.values(OrderReturnType).map(type => (
                <option key={type} value={type}>
                  {tAll(`orders.detail.returns.type.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-reason`}>{t('reasonLabel')}</Label>
            <select
              id={`${id}-reason`}
              className={SELECT_CLASS}
              value={draft.reason}
              onChange={event =>
                setDraft({ ...draft, reason: asReturnReasonKey(event.target.value) ?? '' })
              }
            >
              <option value="">{t('reasonChoose')}</option>
              {OrderReturnReasonKeys.map(key => (
                <option key={key} value={key}>
                  {tAll(`orders.return.reason.${key}`)}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('unitsLegend')}</legend>
            {order.items.map(item => {
              const available = left.get(item.id) ?? 0
              const typed = draft.quantities[item.id] ?? ''
              const bad = unitsOf(typed, available) === null
              return (
                <div key={item.id} className="flex items-center gap-2 text-sm">
                  <Label htmlFor={`${id}-${item.id}`} className="flex-1 font-normal">
                    {item.productName}
                    {item.variantName === null ? '' : ` - ${item.variantName}`}
                    <span className="text-muted-foreground">
                      {' '}
                      {t('available', { count: available })}
                    </span>
                  </Label>
                  <Input
                    id={`${id}-${item.id}`}
                    inputMode="numeric"
                    className="w-20"
                    disabled={available === 0}
                    value={typed}
                    aria-invalid={bad}
                    onChange={event =>
                      setDraft({
                        ...draft,
                        quantities: { ...draft.quantities, [item.id]: event.target.value }
                      })
                    }
                  />
                </div>
              )
            })}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-payer`}>{t('payerLabel')}</Label>
            <select
              id={`${id}-payer`}
              className={SELECT_CLASS}
              value={draft.payer}
              onChange={event =>
                setDraft({ ...draft, payer: event.target.value as ShippingPayer | '' })
              }
            >
              <option value="">{t('payerDefault')}</option>
              {Object.values(ShippingPayer).map(payer => (
                <option key={payer} value={payer}>
                  {tAll(`orders.detail.returns.payer.${payer}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-notes`}>{t('notesLabel')}</Label>
            <Textarea
              id={`${id}-notes`}
              rows={2}
              maxLength={ReturnLimits.NOTES_MAX_LENGTH}
              value={draft.notes}
              onChange={event => setDraft({ ...draft, notes: event.target.value })}
            />
          </div>
        </div>
        <MutationError error={mutation.error} />
        <Footer
          pending={mutation.isPending}
          disabled={body === null}
          confirmLabel={t('confirm')}
          onClose={onClose}
          onConfirm={() => {
            if (body === null) return
            mutation.mutate(body, {
              onSuccess: () => {
                toast.success(t('done'))
                onClose()
              }
            })
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

// The replacement of an exchange: the products that go out instead (the picker of the order form); the rest is the returned order's
function ReplacementFields({
  lines,
  shipping,
  onLines,
  onShipping
}: {
  lines: ReplacementLineDraft[]
  shipping: string
  onLines: (lines: ReplacementLineDraft[]) => void
  onShipping: (text: string) => void
}): ReactElement {
  const t = useTranslations('orders.detail.returns.action.approve')
  const id = useId()
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{t('replacementLegend')}</p>
      <OrderProductPicker
        onAdd={line =>
          onLines([
            ...lines,
            {
              key: crypto.randomUUID(),
              productId: line.productId,
              variantId: line.variantId,
              productName: line.productName,
              variantName: line.variantName,
              quantity: '1'
            }
          ])
        }
      />
      <ul className="flex flex-col gap-1.5 text-sm">
        {lines.map(line => (
          <li key={line.key} className="flex items-center gap-2">
            <span className="flex-1 break-words">
              {line.productName}
              {line.variantName === null ? '' : ` - ${line.variantName}`}
            </span>
            <Input
              aria-label={t('quantityLabel', { name: line.productName })}
              inputMode="numeric"
              className="w-16"
              value={line.quantity}
              onChange={event =>
                onLines(
                  lines.map(entry =>
                    entry.key === line.key ? { ...entry, quantity: event.target.value } : entry
                  )
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('remove', { name: line.productName })}
              onClick={() => onLines(lines.filter(entry => entry.key !== line.key))}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-fee`}>{t('shippingLabel')}</Label>
        <Input
          id={`${id}-fee`}
          inputMode="decimal"
          value={shipping}
          onChange={event => onShipping(event.target.value)}
        />
      </div>
    </div>
  )
}

const CONDITIONS = Object.values(OrderReturnCondition)

// One move of a return and what it asks: nothing (approving a refund, marking it on its way), the replacement (approving an
// exchange), the condition of every line (receiving), the money given back (completing a refund) or a note (refusing, cancelling).
export function ReturnActionDialog({
  action,
  returnView,
  order,
  warehouses,
  writes,
  onClose
}: {
  action: Exclude<
    (typeof ReturnActions)[keyof typeof ReturnActions],
    typeof ReturnActions.RETURN_GUIDE
  >
  returnView: ReturnView
  order: OrderDetailView
  warehouses: readonly WarehouseOption[]
  writes: ReturnWrites
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.detail.returns.action')
  const tAll = useTranslations()
  const id = useId()
  const [notes, setNotes] = useState('')
  const [amount, setAmount] = useState('')
  const [lines, setLines] = useState<ReplacementLineDraft[]>([])
  const [shipping, setShipping] = useState('')
  const [received, setReceived] = useState<Record<string, ReceiveLineDraft>>({})

  const returnId = returnView.id
  const mutation = {
    [ReturnActions.APPROVE]: writes.approve,
    [ReturnActions.REJECT]: writes.reject,
    [ReturnActions.CANCEL]: writes.cancel,
    [ReturnActions.IN_TRANSIT]: writes.inTransit,
    [ReturnActions.RECEIVE]: writes.receive,
    [ReturnActions.COMPLETE]: writes.complete
  }[action]

  const approve = approveBody(returnView.type, { lines, shipping }, order)
  const receive = receiveBody(returnView.lines, received)
  const complete = completeBody(returnView.type, amount, notes)
  const noteText = notes.trim()
  const ready =
    action === ReturnActions.APPROVE
      ? approve !== null
      : action === ReturnActions.RECEIVE
        ? receive !== null
        : action === ReturnActions.COMPLETE
          ? complete !== null
          : true

  const done = (): void => {
    toast.success(t(`${action}.done`))
    onClose()
  }
  const submit = (): void => {
    const options = { onSuccess: done }
    switch (action) {
      case ReturnActions.APPROVE:
        if (approve !== null) writes.approve.mutate({ returnId, body: approve }, options)
        return
      case ReturnActions.REJECT:
        writes.reject.mutate(
          { returnId, body: noteText === '' ? {} : { notes: noteText } },
          options
        )
        return
      case ReturnActions.CANCEL:
        writes.cancel.mutate(
          { returnId, body: noteText === '' ? {} : { notes: noteText } },
          options
        )
        return
      case ReturnActions.IN_TRANSIT:
        writes.inTransit.mutate(returnId, options)
        return
      case ReturnActions.RECEIVE:
        if (receive !== null) writes.receive.mutate({ returnId, body: receive }, options)
        return
      case ReturnActions.COMPLETE:
        if (complete !== null) writes.complete.mutate({ returnId, body: complete }, options)
        return
    }
  }

  return (
    <Dialog open onOpenChange={next => (next || mutation.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(`${action}.title`)}</DialogTitle>
          <DialogDescription>
            {action === ReturnActions.APPROVE
              ? t(`approve.description.${returnView.type}`)
              : t(`${action}.description`)}
          </DialogDescription>
        </DialogHeader>
        {action === ReturnActions.APPROVE && returnView.type === OrderReturnType.EXCHANGE ? (
          <ReplacementFields
            lines={lines}
            shipping={shipping}
            onLines={setLines}
            onShipping={setShipping}
          />
        ) : null}
        {action === ReturnActions.REJECT || action === ReturnActions.CANCEL ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-notes`}>{t('notesLabel')}</Label>
            <Textarea
              id={`${id}-notes`}
              rows={3}
              maxLength={ReturnLimits.NOTES_MAX_LENGTH}
              value={notes}
              onChange={event => setNotes(event.target.value)}
            />
          </div>
        ) : null}
        {action === ReturnActions.RECEIVE ? (
          <div className="flex flex-col gap-3">
            {returnView.lines.map(line => {
              const entry = received[line.orderItemId] ?? { condition: '', warehouseId: '' }
              const set = (next: ReceiveLineDraft): void =>
                setReceived({ ...received, [line.orderItemId]: next })
              return (
                <fieldset key={line.id} className="flex flex-col gap-1.5 text-sm">
                  <legend className="font-medium">
                    {line.productName}
                    {line.variantName === null ? '' : ` - ${line.variantName}`} x {line.quantity}
                  </legend>
                  <select
                    aria-label={t('receive.conditionLabel', { name: line.productName })}
                    className={SELECT_CLASS}
                    value={entry.condition}
                    onChange={event =>
                      set({
                        ...entry,
                        condition: event.target.value as OrderReturnCondition | ''
                      })
                    }
                  >
                    <option value="">{t('receive.conditionChoose')}</option>
                    {CONDITIONS.map(condition => (
                      <option key={condition} value={condition}>
                        {tAll(`orders.detail.returns.condition.${condition}`)}
                      </option>
                    ))}
                  </select>
                  {entry.condition === OrderReturnCondition.RESELLABLE ? (
                    <select
                      aria-label={t('receive.warehouseLabel', { name: line.productName })}
                      className={SELECT_CLASS}
                      value={entry.warehouseId}
                      onChange={event => set({ ...entry, warehouseId: event.target.value })}
                    >
                      <option value="">{t('receive.warehouseDefault')}</option>
                      {warehouses.map(warehouse => (
                        <option key={warehouse.id} value={warehouse.id}>
                          {warehouse.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </fieldset>
              )
            })}
          </div>
        ) : null}
        {action === ReturnActions.COMPLETE ? (
          <div className="flex flex-col gap-3">
            {returnView.type === OrderReturnType.REFUND ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-amount`}>{t('complete.amountLabel')}</Label>
                <Input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  value={amount}
                  aria-invalid={complete === null}
                  onChange={event => setAmount(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t('complete.amountHint')}</p>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-notes`}>{t('notesLabel')}</Label>
              <Textarea
                id={`${id}-notes`}
                rows={2}
                maxLength={ReturnLimits.NOTES_MAX_LENGTH}
                value={notes}
                onChange={event => setNotes(event.target.value)}
              />
            </div>
          </div>
        ) : null}
        <MutationError error={mutation.error} />
        <Footer
          pending={mutation.isPending}
          disabled={!ready}
          confirmLabel={t(`${action}.confirm`)}
          onClose={onClose}
          onConfirm={submit}
        />
      </DialogContent>
    </Dialog>
  )
}
