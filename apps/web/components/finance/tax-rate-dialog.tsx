'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { FinanceAccountView, FinanceTaxRateView } from '@platform/api-client'

import {
  emptyTaxRateDraft,
  createTaxRateInputOf,
  type TaxRateDraft,
  type TaxRateField,
  TaxRateFields,
  TaxAccountSides,
  taxAccountsOf,
  taxRateDraftOf,
  taxRateProblem,
  updateTaxRateInputOf
} from '../../lib/finance/tax-form'
import { useCreateFinanceTaxRate, useUpdateFinanceTaxRate } from '../../lib/finance/use-finance'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField, TextField } from './fields'

// Making and editing a tax rate (TDD_18 §7). `rate` is null to make one. The rate is typed as a percent; the accounts are the ones the
// tax of a sale (output) and of a purchase (input) is posted to.
export function TaxRateDialog({
  rate,
  accounts,
  open,
  onOpenChange
}: {
  rate: FinanceTaxRateView | null
  accounts: readonly FinanceAccountView[]
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.taxes.dialog')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rate === null ? t('createTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>
            {rate === null ? t('createDescription') : t('editDescription')}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <TaxRateForm
            key={rate?.id ?? 'new'}
            rate={rate}
            accounts={accounts}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaxRateForm({
  rate,
  accounts,
  onDone
}: {
  rate: FinanceTaxRateView | null
  accounts: readonly FinanceAccountView[]
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.taxes')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const create = useCreateFinanceTaxRate(storeId)
  const update = useUpdateFinanceTaxRate(storeId)
  const [draft, setDraft] = useState<TaxRateDraft>(() =>
    rate === null ? emptyTaxRateDraft() : taxRateDraftOf(rate)
  )
  const [wrong, setWrong] = useState<TaxRateField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = create.isPending || update.isPending
  // The draft is read for its changes only once it is a valid one: before that the form shows the problem and sends nothing
  const valid = taxRateProblem(draft) === null
  const changes = rate === null || !valid ? null : updateTaxRateInputOf(rate, draft)
  const changed = rate === null || changes === null || Object.keys(changes).length > 0

  const set = (patch: Partial<TaxRateDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = taxRateProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!changed || !guard.enter()) return
    const handlers = {
      onError: (error: Error) => setRefusal(errorText(error)),
      onSettled: guard.leave
    }
    if (rate === null) {
      create.mutate(createTaxRateInputOf(draft), {
        ...handlers,
        onSuccess: view => {
          toast.success(t('dialog.created', { name: view.name }))
          onDone()
        }
      })
      return
    }
    update.mutate(
      { id: rate.id, changes: changes ?? {} },
      {
        ...handlers,
        onSuccess: () => {
          toast.success(t('dialog.saved'))
          onDone()
        }
      }
    )
  }

  const problemText = (field: TaxRateField): string | null =>
    wrong === field ? t(`problems.${field}`) : null

  const accountSelect = (
    field: 'outputAccountId' | 'inputAccountId',
    options: readonly FinanceAccountView[],
    label: string,
    hint: string,
    problem: TaxRateField
  ): ReactElement => (
    <SelectField
      label={label}
      value={draft[field]}
      hint={hint}
      disabled={pending}
      problem={problemText(problem)}
      onChange={value => set({ [field]: value })}
    >
      <option value="">{t('fields.pickAccount')}</option>
      {options.map(account => (
        <option key={account.id} value={account.id}>
          {account.code} · {account.name}
        </option>
      ))}
    </SelectField>
  )

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3"
      aria-label={t('dialog.formLabel')}
    >
      <TextField
        label={t('fields.code')}
        value={draft.code}
        maxLength={20}
        disabled={pending}
        problem={problemText(TaxRateFields.CODE)}
        onChange={code => set({ code })}
      />
      <TextField
        label={t('fields.name')}
        value={draft.name}
        maxLength={100}
        disabled={pending}
        problem={problemText(TaxRateFields.NAME)}
        onChange={name => set({ name })}
      />
      <TextField
        label={t('fields.percent')}
        value={draft.percent}
        inputMode="decimal"
        maxLength={6}
        disabled={pending}
        hint={t('fields.percentHint')}
        problem={problemText(TaxRateFields.PERCENT)}
        onChange={percent => set({ percent })}
      />
      {accountSelect(
        'outputAccountId',
        taxAccountsOf(accounts, TaxAccountSides.OUTPUT, [draft.outputAccountId]),
        t('fields.outputAccount'),
        t('fields.outputHint'),
        TaxRateFields.OUTPUT_ACCOUNT
      )}
      {accountSelect(
        'inputAccountId',
        taxAccountsOf(accounts, TaxAccountSides.INPUT, [draft.inputAccountId]),
        t('fields.inputAccount'),
        t('fields.inputHint'),
        TaxRateFields.INPUT_ACCOUNT
      )}
      {rate?.isDefault === true ? (
        <p className="text-muted-foreground text-sm">{t('fields.isDefaultNow')}</p>
      ) : (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.isDefault}
            disabled={pending}
            onChange={event => set({ isDefault: event.target.checked })}
          />
          <span>
            {t('fields.makeDefault')}
            <span className="text-muted-foreground block text-xs">
              {t('fields.makeDefaultHint')}
            </span>
          </span>
        </label>
      )}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {t('dialog.cancel')}
        </Button>
        <Button type="submit" disabled={pending || !changed}>
          {rate === null ? t('dialog.create') : t('dialog.save')}
        </Button>
      </div>
    </form>
  )
}
