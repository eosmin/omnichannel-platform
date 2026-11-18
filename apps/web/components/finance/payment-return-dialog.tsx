'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react'

import type { SupplierPaymentView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { PurchaseLimits } from '@platform/core/domain'

import { cashAccountsOf } from '../../lib/finance/account-form'
import { moneyText } from '../../lib/finance/money'
import {
  emptyReturnDraft,
  type ReturnDraft,
  type ReturnField,
  returnInputOf,
  returnProblem
} from '../../lib/finance/payment-return-form'
import { dayOfDate, newIdempotencyKey } from '../../lib/finance/purchase-form'
import { useFinanceAccounts } from '../../lib/finance/use-finance'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useRecordPaymentReturn } from '../../lib/finance/use-purchases'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField, TextField } from './fields'

// What a supplier gave back of a payment: the bank returned it or it bounced (TDD_18 §4.2 E11b). The payment stays as it was; the return
// is its own record that reopens the debt. The key makes a double click one return. Needs `finance:move_money` (the button is the caller's)
// and `finance:view` to read the chart the account is chosen from.
export function PaymentReturnDialog({
  payment,
  open,
  onOpenChange
}: {
  payment: SupplierPaymentView | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.paymentReturn')
  // A return on its way is never walked away from: closing the box would lose its answer and its key
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
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open && payment !== null ? (
          <ReturnForm
            key={payment.id}
            payment={payment}
            onBusy={setBusy}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ReturnForm({
  payment,
  onBusy,
  onDone
}: {
  payment: SupplierPaymentView
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.purchases.paymentReturn')
  const locale = useLocale()
  const errorText = usePurchaseErrorText()
  const { storeId, can } = useStore()
  const canReadBooks = can(ClientPermissions.FINANCE_VIEW)
  const guard = useSubmitGuard()
  const accounts = useFinanceAccounts(storeId, canReadBooks)
  const record = useRecordPaymentReturn(storeId)
  // One key for the life of the form: a retry after a lost answer is the same return
  const [key] = useState(newIdempotencyKey)
  const today = dayOfDate(new Date())
  const [draft, setDraft] = useState<ReturnDraft>(() => emptyReturnDraft(today, payment))
  const [wrong, setWrong] = useState<ReturnField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = record.isPending
  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])
  const choices = useMemo(
    () => cashAccountsOf(accounts.data ?? [], [payment.paidFromAccountId]),
    [accounts.data, payment.paidFromAccountId]
  )

  const set = (patch: Partial<ReturnDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = returnProblem(draft, payment, today)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    record.mutate(
      { paymentId: payment.id, input: returnInputOf(draft, key) },
      {
        onSuccess: () => {
          toast.success(t('done'))
          onDone()
        },
        onError: (error: Error) => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  const problemText = (field: ReturnField): string | null =>
    wrong === field ? t(`problems.${field}`) : null

  if (!canReadBooks) return <p className="text-muted-foreground text-sm">{t('needsBooks')}</p>
  if (accounts.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('accountsFailed')}
      </p>
    )
  }
  if (accounts.isPending) {
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <p className="text-sm" data-testid="payment-return-target">
        {t('ofPayment', { amount: moneyText(locale, payment.amountCents) })}
      </p>
      <SelectField
        label={t('fields.account')}
        value={draft.receivedIntoAccountId}
        hint={t('fields.accountHint')}
        disabled={pending}
        problem={problemText('receivedIntoAccountId')}
        onChange={receivedIntoAccountId => set({ receivedIntoAccountId })}
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
        label={t('fields.returnedOn')}
        value={draft.returnedOn}
        maxLength={10}
        disabled={pending}
        hint={t('fields.dateHint')}
        problem={problemText('returnedOn')}
        onChange={returnedOn => set({ returnedOn })}
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
