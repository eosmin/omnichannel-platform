'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type {
  FinanceAccountView,
  FinanceTaxRateView,
  FinanceTransactionView
} from '@platform/api-client'
import { FinanceTransactionKind } from '@platform/core/domain'

import { accountLabelsOf } from '../../lib/finance/account-form'
import { dayOfClock, dayOfUtcClock, nextDay } from '../../lib/finance/dates'
import { percentOfBps } from '../../lib/finance/money'
import {
  categoryAccountsOf,
  emptyTransactionDraft,
  moneyAccountsOf,
  recordTransactionInputOf,
  takesCategory,
  takesCreditableTax,
  takesDestination,
  takesSource,
  takesTax,
  taxPreviewOf,
  taxRatesOf,
  type TransactionDraft,
  type TransactionField,
  TransactionFields,
  transactionDraftOf,
  transactionProblem
} from '../../lib/finance/transaction-form'
import {
  useRecordFinanceTransaction,
  useReplaceFinanceTransaction,
  useFinanceReceiptUpload
} from '../../lib/finance/use-finance'
import { useMoney } from '../../lib/finance/use-money'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField, TextField } from './fields'
import { ReceiptFileField } from './receipt-file-field'

// Registering an expense, an income or a transfer by hand, and replacing one (TDD_18 §4.3). `replace` is null to register. The kinds
// offered are the ones whose permission the person holds; a replacement keeps the kind of the transaction it replaces. The amount is typed
// as dollars and sent as cents; the accounts each field offers are the ones the api accepts there; the tax shown is the one the api
// computes. An optional receipt travels once the transaction exists.
export function TransactionFormDialog({
  replace,
  kinds,
  accounts,
  rates,
  rounding,
  open,
  onOpenChange,
  onSaved
}: {
  replace: FinanceTransactionView | null
  kinds: readonly string[]
  accounts: readonly FinanceAccountView[]
  rates: readonly FinanceTaxRateView[]
  rounding: string
  open: boolean
  onOpenChange: (open: boolean) => void
  // After a replacement, the dialog that opened this one closes too
  onSaved?: () => void
}): ReactElement {
  const t = useTranslations('finance.transactions.form')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{replace === null ? t('createTitle') : t('replaceTitle')}</DialogTitle>
          <DialogDescription>
            {replace === null ? t('createDescription') : t('replaceDescription')}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <TransactionForm
            key={replace?.id ?? 'new'}
            replace={replace}
            kinds={kinds}
            accounts={accounts}
            rates={rates}
            rounding={rounding}
            onDone={() => {
              onOpenChange(false)
              onSaved?.()
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

type Wrong = TransactionField | 'reason'

function TransactionForm({
  replace,
  kinds,
  accounts,
  rates,
  rounding,
  onDone,
  onCancel
}: {
  replace: FinanceTransactionView | null
  kinds: readonly string[]
  accounts: readonly FinanceAccountView[]
  rates: readonly FinanceTaxRateView[]
  rounding: string
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const t = useTranslations('finance.transactions')
  const errorText = useErrorText()
  const money = useMoney()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const run = useDestructiveAction()
  const record = useRecordFinanceTransaction(storeId)
  const replaceTransaction = useReplaceFinanceTransaction(storeId)
  const upload = useFinanceReceiptUpload(storeId)
  const [today] = useState(() => dayOfClock(new Date()))
  // The api accepts a day ahead of its own today, which is the UTC day
  const [latestDay] = useState(() => nextDay(dayOfUtcClock(new Date())))
  const [draft, setDraft] = useState<TransactionDraft>(() =>
    replace === null
      ? emptyTransactionDraft(kinds[0] ?? FinanceTransactionKind.EXPENSE, today)
      : transactionDraftOf(replace)
  )
  // A new content is a new key: the api refuses one key for two contents, and takes the same key and content as one request
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [reason, setReason] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [wrong, setWrong] = useState<Wrong | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = (patch: Partial<TransactionDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setKey(crypto.randomUUID())
    setWrong(null)
    setRefusal(null)
  }
  const setKind = (kind: string): void =>
    set({
      kind,
      fromAccountId: '',
      toAccountId: '',
      categoryAccountId: '',
      taxRateId: '',
      taxCreditable: false
    })

  const { kind } = draft
  const label = accountLabelsOf(accounts)
  const keep = (id: string): string[] => (id === '' ? [] : [id])
  const sources = moneyAccountsOf(accounts, keep(draft.fromAccountId))
  const destinations = moneyAccountsOf(accounts, keep(draft.toAccountId))
  const categories = categoryAccountsOf(accounts, kind, keep(draft.categoryAccountId))
  const rateOptions = taxRatesOf(rates, keep(draft.taxRateId))
  const tax = taxPreviewOf(draft, rates, rounding)
  const problemText = (field: TransactionField): string | null =>
    wrong === field ? t(`form.problems.${field}`) : null
  const isTransfer = !takesCategory(kind)

  // The transaction is registered first and then its receipt: a receipt that fails leaves a transaction with none, said in a toast, and
  // the person attaches it from the detail. The refusal of the transaction itself stays in the form.
  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setSaving(true)
    try {
      const input = recordTransactionInputOf(draft, key)
      let saved: FinanceTransactionView
      try {
        saved =
          replace === null
            ? await record.mutateAsync(input)
            : await replaceTransaction.mutateAsync({
                id: replace.id,
                reason: reason.trim(),
                replacement: input
              })
      } catch (error) {
        setRefusal(errorText(error))
        return
      }
      if (file !== null) {
        try {
          await upload.mutateAsync({ transactionId: saved.id, file })
        } catch {
          toast.error(t('form.receiptNotSaved'))
        }
      }
      toast.success(replace === null ? t('form.created') : t('form.replaced'))
      onDone()
    } finally {
      setSaving(false)
      guard.leave()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = transactionProblem(draft, latestDay, rates, rounding)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (replace === null) {
      void send()
      return
    }
    if (reason.trim() === '') {
      setWrong('reason')
      return
    }
    // Replacing voids the transaction: the HIGH tier of voiding one, asked the way the store decided
    run('VOID_FINANCE_TRANSACTION', {
      title: t('form.confirmReplaceTitle'),
      description: t('form.confirmReplaceDescription'),
      confirmLabel: t('form.confirmReplace'),
      onConfirm: send
    })
  }

  const accountOptions = (list: readonly FinanceAccountView[]): ReactElement[] =>
    list.map(account => (
      <option key={account.id} value={account.id}>
        {label(account.id)}
      </option>
    ))

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3"
      aria-label={t('form.formLabel')}
    >
      {replace === null && kinds.length > 1 ? (
        <SelectField label={t('form.kind')} value={kind} disabled={saving} onChange={setKind}>
          {kinds.map(option => (
            <option key={option} value={option}>
              {t(`kinds.${option as 'expense'}`)}
            </option>
          ))}
        </SelectField>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('form.date')}
          type="date"
          value={draft.occurredOn}
          disabled={saving}
          problem={problemText(TransactionFields.DATE)}
          onChange={occurredOn => set({ occurredOn })}
        />
        <TextField
          label={t('form.amount')}
          value={draft.amount}
          inputMode="decimal"
          maxLength={13}
          disabled={saving}
          hint={t('form.amountHint')}
          problem={problemText(TransactionFields.AMOUNT)}
          onChange={amount => set({ amount })}
        />
      </div>
      {takesSource(kind) ? (
        <SelectField
          label={isTransfer ? t('form.transferFrom') : t('form.expenseFrom')}
          value={draft.fromAccountId}
          disabled={saving}
          problem={problemText(TransactionFields.FROM)}
          onChange={fromAccountId => set({ fromAccountId })}
        >
          <option value="">{t('form.pickAccount')}</option>
          {accountOptions(sources)}
        </SelectField>
      ) : null}
      {takesDestination(kind) ? (
        <SelectField
          label={isTransfer ? t('form.transferTo') : t('form.incomeTo')}
          value={draft.toAccountId}
          disabled={saving}
          problem={problemText(TransactionFields.TO)}
          onChange={toAccountId => set({ toAccountId })}
        >
          <option value="">{t('form.pickAccount')}</option>
          {accountOptions(destinations)}
        </SelectField>
      ) : null}
      {takesCategory(kind) ? (
        <SelectField
          label={
            kind === String(FinanceTransactionKind.EXPENSE)
              ? t('form.expenseCategory')
              : t('form.incomeCategory')
          }
          value={draft.categoryAccountId}
          disabled={saving}
          problem={problemText(TransactionFields.CATEGORY)}
          onChange={categoryAccountId => set({ categoryAccountId })}
        >
          <option value="">{t('form.pickCategory')}</option>
          {accountOptions(categories)}
        </SelectField>
      ) : null}
      {takesTax(kind) && rateOptions.length > 0 ? (
        <SelectField
          label={t('form.taxRate')}
          value={draft.taxRateId}
          disabled={saving}
          problem={problemText(TransactionFields.TAX)}
          onChange={taxRateId =>
            set({ taxRateId, ...(taxRateId === '' ? { taxCreditable: false } : {}) })
          }
        >
          <option value="">{t('form.noTax')}</option>
          {rateOptions.map(rate => (
            <option key={rate.id} value={rate.id}>
              {rate.name} ({percentOfBps(rate.rateBps)} %)
            </option>
          ))}
        </SelectField>
      ) : null}
      {tax === null ? null : (
        <p className="text-sm" data-testid="finance-tax-preview">
          {t('form.taxPreview', { amount: money(tax) })}
        </p>
      )}
      {takesCreditableTax(kind) && draft.taxRateId !== '' ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.taxCreditable}
            disabled={saving}
            onChange={event => set({ taxCreditable: event.target.checked })}
          />
          <span>
            {t('form.taxCreditable')}
            <span className="text-muted-foreground block text-xs">
              {t('form.taxCreditableHint')}
            </span>
          </span>
        </label>
      ) : null}
      <TextField
        label={t('form.documentNumber')}
        value={draft.documentNumber}
        maxLength={100}
        disabled={saving}
        problem={problemText(TransactionFields.DOCUMENT_NUMBER)}
        onChange={documentNumber => set({ documentNumber })}
      />
      <TextField
        label={t('form.memo')}
        value={draft.memo}
        maxLength={500}
        disabled={saving}
        problem={problemText(TransactionFields.MEMO)}
        onChange={memo => set({ memo })}
      />
      <ReceiptFileField file={file} onChange={setFile} disabled={saving} />
      {replace === null ? null : (
        <TextField
          label={t('form.reason')}
          value={reason}
          maxLength={500}
          disabled={saving}
          problem={wrong === 'reason' ? t('form.problems.reason') : null}
          onChange={value => {
            setReason(value)
            setWrong(null)
          }}
        />
      )}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={saving} busy={saving}>
          {replace === null ? t('form.submit') : t('form.submitReplace')}
        </Button>
      </div>
    </form>
  )
}
