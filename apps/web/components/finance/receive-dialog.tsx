'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useMemo, useState } from 'react'

import type { FinanceTaxRateView, PurchaseOrderView } from '@platform/api-client'
import { FinanceLimits, TaxRounding } from '@platform/core/domain'

import { moneyText } from '../../lib/finance/money'
import {
  dayOfDate,
  moneyOfLines,
  newIdempotencyKey,
  pendingOf,
  type ReceiveDraft,
  type ReceiveField,
  ReceiveFields,
  receiveDraftOf,
  receiveInputOf,
  receiveProblem,
  wholeOfText
} from '../../lib/finance/purchase-form'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useReceivePurchaseOrder } from '../../lib/finance/use-purchases'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { TextField } from './fields'

// Receiving the goods of a purchase order (TDD_18 §4.2 E10): how many units of each line arrive now, on which day, with which supplier
// document. It makes the receipt (the bill), puts the units in the warehouse and posts the entry in one step, so the cost and the tax are the
// order's and are never typed here; the money shown is the one the api computes (same rule). A phone is the place it is done (the goods are
// at the door), so the form is one column with a big box per line.
export function ReceiveDialog({
  order,
  labels,
  taxRates,
  rounding,
  open,
  onOpenChange
}: {
  order: PurchaseOrderView
  labels: ReadonlyMap<string, string>
  taxRates: readonly FinanceTaxRateView[] | null
  rounding: TaxRounding | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.receive')
  // A receipt on its way is never walked away from: closing the box would lose its answer
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title', { number: order.number })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <ReceiveForm
            order={order}
            labels={labels}
            taxRates={taxRates}
            rounding={rounding}
            onBusy={setBusy}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ReceiveForm({
  order,
  labels,
  taxRates,
  rounding,
  onBusy,
  onDone
}: {
  order: PurchaseOrderView
  labels: ReadonlyMap<string, string>
  taxRates: readonly FinanceTaxRateView[] | null
  rounding: TaxRounding | null
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.purchases.receive')
  const locale = useLocale()
  const errorText = usePurchaseErrorText()
  const ids = useId()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const receive = useReceivePurchaseOrder(storeId)
  // One key for the life of the form: a retry after a lost answer is the same receipt, never a second one
  const [key] = useState(newIdempotencyKey)
  const [draft, setDraft] = useState<ReceiveDraft>(() =>
    receiveDraftOf(order, dayOfDate(new Date()))
  )
  const [wrong, setWrong] = useState<{ field: ReceiveField; lineId: string | null } | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    onBusy(receive.isPending)
    return () => onBusy(false)
  }, [receive.isPending, onBusy])
  const rateOf = useMemo(
    () => new Map((taxRates ?? []).map(rate => [rate.id, rate.rateBps])),
    [taxRates]
  )
  const known = taxRates !== null && rounding !== null
  const money = useMemo(() => {
    const arriving = order.lines.flatMap(line => {
      const quantity = wholeOfText((draft.quantities[line.id] ?? '').trim() || '0')
      return quantity === null || quantity < 1 || quantity > pendingOf(line)
        ? []
        : [{ quantity, unitCostCents: line.unitCostCents, taxRateId: line.taxRateId }]
    })
    return moneyOfLines(arriving, id => rateOf.get(id) ?? null, rounding ?? TaxRounding.HALF_UP)
  }, [order.lines, draft.quantities, rateOf, rounding])

  const set = (patch: Partial<ReceiveDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = receiveProblem(order, draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    receive.mutate(
      { id: order.id, input: receiveInputOf(order, draft, key) },
      {
        onSuccess: () => {
          toast.success(t('done', { number: order.number }))
          onDone()
        },
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  const problemText = (field: ReceiveField): string | null =>
    wrong?.field === field ? t(`problems.${field}`) : null

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <ul className="flex flex-col gap-3" data-testid="receive-lines">
        {order.lines.map(line => {
          const pending = pendingOf(line)
          const id = `${ids}-${line.id}`
          return (
            <li
              key={line.id}
              data-testid="receive-line"
              className="flex flex-col gap-1.5 rounded-md border p-3"
            >
              <Label htmlFor={id}>{labels.get(line.id) ?? line.productId.slice(0, 8)}</Label>
              <span className="text-muted-foreground text-xs">
                {t('progress', { received: line.receivedQuantity, ordered: line.quantity })}
              </span>
              <Input
                id={id}
                value={draft.quantities[line.id] ?? ''}
                inputMode="numeric"
                disabled={pending === 0 || receive.isPending}
                aria-invalid={wrong?.lineId === line.id}
                className="pointer-coarse:h-12"
                onChange={event =>
                  set({ quantities: { ...draft.quantities, [line.id]: event.target.value } })
                }
              />
              {wrong?.lineId === line.id ? (
                <p role="alert" className="text-destructive text-sm">
                  {t('problems.quantity', { max: pending })}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
      {wrong?.field === ReceiveFields.NOTHING ? (
        <p role="alert" className="text-destructive text-sm">
          {t('problems.nothing')}
        </p>
      ) : null}
      <TextField
        label={t('fields.receivedOn')}
        value={draft.receivedOn}
        maxLength={10}
        disabled={receive.isPending}
        hint={t('fields.dateHint')}
        problem={problemText(ReceiveFields.DATE)}
        onChange={receivedOn => set({ receivedOn })}
      />
      <TextField
        label={t('fields.document')}
        value={draft.supplierDocumentNumber}
        maxLength={FinanceLimits.DOCUMENT_NUMBER_MAX_LENGTH}
        disabled={receive.isPending}
        hint={t('fields.documentHint')}
        problem={problemText(ReceiveFields.DOCUMENT)}
        onChange={supplierDocumentNumber => set({ supplierDocumentNumber })}
      />
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={draft.creditTax && draft.supplierDocumentNumber.trim() !== ''}
          disabled={receive.isPending || draft.supplierDocumentNumber.trim() === ''}
          onChange={event => set({ creditTax: event.target.checked })}
        />
        <span>
          {t('fields.creditTax')}
          <span className="text-muted-foreground block text-xs">{t('fields.creditTaxHint')}</span>
        </span>
      </label>
      <dl className="grid grid-cols-3 gap-3 text-sm" data-testid="receive-totals">
        <div className="flex flex-col">
          <dt className="text-muted-foreground text-xs">{t('subtotal')}</dt>
          <dd className="tabular-nums">{moneyText(locale, money.subtotalCents)}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted-foreground text-xs">{t('tax')}</dt>
          <dd className="tabular-nums">
            {known ? moneyText(locale, money.taxCents) : t('taxUnknown')}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted-foreground text-xs">{t('total')}</dt>
          <dd className="font-semibold tabular-nums">
            {known ? moneyText(locale, money.totalCents) : t('taxUnknown')}
          </dd>
        </div>
      </dl>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={receive.isPending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={receive.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
