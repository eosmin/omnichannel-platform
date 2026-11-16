'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { PurchaseLimits } from '@platform/core/domain'

import { cashAccountsOf } from '../../lib/finance/account-form'
import { moneyText } from '../../lib/finance/money'
import {
  dayOfDate,
  emptyPaymentDraft,
  newIdempotencyKey,
  type PaymentDraft,
  type PaymentField,
  paymentInputOf,
  paymentProblem
} from '../../lib/finance/purchase-form'
import { useFinanceAccounts } from '../../lib/finance/use-finance'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import {
  useRecordPurchaseOrderPayment,
  useRecordSupplierPayment
} from '../../lib/finance/use-purchases'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField, TextField } from './fields'

// What a payment is for: a bill (its open amount is the most it takes) or what the supplier is owed in all
export interface PaymentTarget {
  supplierId: string
  supplierName: string
  // The route of the purchase order when the payment is made from one: the api then checks the bill is the order's
  orderId: string | null
  bill: { receiptId: string; label: string; openCents: number } | null
  // What the supplier is owed in all: the most a payment without a bill takes
  supplierOpenCents: number
}

// Registering a payment to a supplier (TDD_18 §4.2 E11). The account the money leaves is one of cash, bank or wallet; the amount is typed as
// dollars and sent as cents; the key makes a double click one payment. Needs `finance:move_money` (the button is the caller's) and
// `finance:view` to read the chart the account is chosen from.
export function PaymentDialog({
  target,
  open,
  onOpenChange
}: {
  target: PaymentTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.payment')
  // A payment on its way is never walked away from: closing the box would lose its answer and its key, and the next try would pay twice
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
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {target === null ? '' : t('description', { supplier: target.supplierName })}
          </DialogDescription>
        </DialogHeader>
        {open && target !== null ? (
          <PaymentForm
            key={target.bill?.receiptId ?? target.supplierId}
            target={target}
            onBusy={setBusy}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function PaymentForm({
  target,
  onBusy,
  onDone
}: {
  target: PaymentTarget
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.purchases.payment')
  const locale = useLocale()
  const errorText = usePurchaseErrorText()
  const { storeId, can } = useStore()
  const canReadBooks = can(ClientPermissions.FINANCE_VIEW)
  const guard = useSubmitGuard()
  const accounts = useFinanceAccounts(storeId, canReadBooks)
  const payBySupplier = useRecordSupplierPayment(storeId)
  const payByOrder = useRecordPurchaseOrderPayment(storeId)
  // One key for the life of the form: a retry after a lost answer is the same payment
  const [key] = useState(newIdempotencyKey)
  const openCents = target.bill?.openCents ?? target.supplierOpenCents
  const [draft, setDraft] = useState<PaymentDraft>(() =>
    emptyPaymentDraft(
      dayOfDate(new Date()),
      target.bill === null ? undefined : { receiptId: target.bill.receiptId, openCents }
    )
  )
  const [wrong, setWrong] = useState<PaymentField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = payBySupplier.isPending || payByOrder.isPending
  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])
  const choices = useMemo(() => cashAccountsOf(accounts.data ?? [], []), [accounts.data])

  const set = (patch: Partial<PaymentDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = paymentProblem(draft, openCents)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    const input = paymentInputOf(draft, key)
    const handlers = {
      onSuccess: () => {
        toast.success(t('done', { supplier: target.supplierName }))
        onDone()
      },
      onError: (error: Error) => setRefusal(errorText(error)),
      onSettled: guard.leave
    }
    if (target.orderId === null) {
      payBySupplier.mutate({ supplierId: target.supplierId, input }, handlers)
    } else {
      payByOrder.mutate({ orderId: target.orderId, input }, handlers)
    }
  }

  const problemText = (field: PaymentField): string | null =>
    wrong === field ? t(`problems.${field}`) : null

  if (!canReadBooks) return <p className="text-muted-foreground text-sm">{t('needsBooks')}</p>
  if (accounts.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('accountsFailed')}
      </p>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <p className="text-sm" data-testid="payment-target">
        {target.bill === null
          ? t('owedInAll', { amount: moneyText(locale, openCents) })
          : t('owedOnBill', { bill: target.bill.label, amount: moneyText(locale, openCents) })}
      </p>
      <SelectField
        label={t('fields.account')}
        value={draft.paidFromAccountId}
        hint={t('fields.accountHint')}
        disabled={pending}
        problem={problemText('paidFromAccountId')}
        onChange={paidFromAccountId => set({ paidFromAccountId })}
      >
        <option value="">{t('fields.pickAccount')}</option>
        {choices.map(account => (
          <option key={account.id} value={account.id}>
            {account.code} · {account.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label={t('fields.amount')}
        value={draft.amount}
        inputMode="decimal"
        maxLength={14}
        disabled={pending}
        hint={t('fields.amountHint')}
        problem={problemText('amount')}
        onChange={amount => set({ amount })}
      />
      <TextField
        label={t('fields.paidOn')}
        value={draft.paidOn}
        maxLength={10}
        disabled={pending}
        hint={t('fields.dateHint')}
        problem={problemText('paidOn')}
        onChange={paidOn => set({ paidOn })}
      />
      <TextField
        label={t('fields.reference')}
        value={draft.reference}
        maxLength={PurchaseLimits.REFERENCE_MAX_LENGTH}
        disabled={pending}
        problem={problemText('reference')}
        onChange={reference => set({ reference })}
      />
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
