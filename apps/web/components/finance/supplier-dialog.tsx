'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react'

import type { FinanceAccountView, SupplierView } from '@platform/api-client'
import { AccountType, PurchaseLimits } from '@platform/core/domain'

import { postableAccountsOf } from '../../lib/finance/account-form'
import {
  createSupplierInputOf,
  emptySupplierDraft,
  type SupplierDraft,
  type SupplierField,
  SupplierFields,
  supplierDraftOf,
  supplierProblem,
  updateSupplierInputOf
} from '../../lib/finance/purchase-form'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useCreateSupplier, useUpdateSupplier } from '../../lib/finance/use-purchases'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField, TextField } from './fields'

// Making and editing a supplier (TDD_18 §2.7). `supplier` is null to make one. The tax id is written as the supplier's document shows it
// (NIT or NRC): nothing is checked about its shape, because the format is the accountant's call, so only its length is. The account
// the bills of a supplier are owed on is a liability that takes entries; `accounts` is null for who cannot read the chart.
export function SupplierDialog({
  supplier,
  accounts,
  open,
  onOpenChange
}: {
  supplier: SupplierView | null
  accounts: readonly FinanceAccountView[] | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.supplierDialog')
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
          <DialogTitle>{supplier === null ? t('createTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>
            {supplier === null ? t('createDescription') : t('editDescription')}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <SupplierForm
            key={supplier?.id ?? 'new'}
            supplier={supplier}
            accounts={accounts}
            onBusy={setBusy}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SupplierForm({
  supplier,
  accounts,
  onBusy,
  onDone
}: {
  supplier: SupplierView | null
  accounts: readonly FinanceAccountView[] | null
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.purchases.supplierDialog')
  const errorText = usePurchaseErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const create = useCreateSupplier(storeId)
  const update = useUpdateSupplier(storeId)
  const [draft, setDraft] = useState<SupplierDraft>(() =>
    supplier === null ? emptySupplierDraft() : supplierDraftOf(supplier)
  )
  const [wrong, setWrong] = useState<SupplierField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = create.isPending || update.isPending
  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])
  const valid = supplierProblem(draft) === null
  const changes = supplier === null || !valid ? null : updateSupplierInputOf(supplier, draft)
  const changed = supplier === null || changes === null || Object.keys(changes).length > 0
  // The payable account of a supplier is a liability; the one already chosen stays in the list
  const payable = useMemo(
    () =>
      accounts === null
        ? []
        : postableAccountsOf(accounts, [draft.defaultPayableAccountId]).filter(
            account =>
              account.type === String(AccountType.LIABILITY) ||
              account.id === draft.defaultPayableAccountId
          ),
    [accounts, draft.defaultPayableAccountId]
  )

  const set = (patch: Partial<SupplierDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = supplierProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!changed || !guard.enter()) return
    const handlers = {
      onError: (error: Error) => setRefusal(errorText(error)),
      onSettled: guard.leave
    }
    if (supplier === null) {
      create.mutate(createSupplierInputOf(draft), {
        ...handlers,
        onSuccess: view => {
          toast.success(t('created', { name: view.name }))
          onDone()
        }
      })
      return
    }
    update.mutate(
      { id: supplier.id, changes: changes ?? {} },
      {
        ...handlers,
        onSuccess: () => {
          toast.success(t('saved'))
          onDone()
        }
      }
    )
  }

  const problemText = (field: SupplierField): string | null =>
    wrong === field ? t(`problems.${field}`) : null

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <TextField
        label={t('fields.name')}
        value={draft.name}
        maxLength={PurchaseLimits.SUPPLIER_NAME_MAX_LENGTH}
        disabled={pending}
        problem={problemText(SupplierFields.NAME)}
        onChange={name => set({ name })}
      />
      <TextField
        label={t('fields.taxId')}
        value={draft.taxId}
        maxLength={PurchaseLimits.SUPPLIER_TAX_ID_MAX_LENGTH}
        disabled={pending}
        hint={t('fields.taxIdHint')}
        problem={problemText(SupplierFields.TAX_ID)}
        onChange={taxId => set({ taxId })}
      />
      <TextField
        label={t('fields.contactName')}
        value={draft.contactName}
        maxLength={PurchaseLimits.SUPPLIER_CONTACT_MAX_LENGTH}
        disabled={pending}
        problem={problemText(SupplierFields.CONTACT_NAME)}
        onChange={contactName => set({ contactName })}
      />
      <TextField
        label={t('fields.email')}
        value={draft.email}
        maxLength={PurchaseLimits.SUPPLIER_EMAIL_MAX_LENGTH}
        disabled={pending}
        problem={problemText(SupplierFields.EMAIL)}
        onChange={email => set({ email })}
      />
      <TextField
        label={t('fields.phone')}
        value={draft.phone}
        maxLength={PurchaseLimits.SUPPLIER_PHONE_MAX_LENGTH}
        disabled={pending}
        problem={problemText(SupplierFields.PHONE)}
        onChange={phone => set({ phone })}
      />
      <TextField
        label={t('fields.paymentTermsDays')}
        value={draft.paymentTermsDays}
        inputMode="numeric"
        maxLength={3}
        disabled={pending}
        hint={t('fields.paymentTermsHint')}
        problem={problemText(SupplierFields.PAYMENT_TERMS)}
        onChange={paymentTermsDays => set({ paymentTermsDays })}
      />
      {accounts === null ? null : (
        <SelectField
          label={t('fields.payableAccount')}
          value={draft.defaultPayableAccountId}
          hint={t('fields.payableAccountHint')}
          disabled={pending}
          onChange={defaultPayableAccountId => set({ defaultPayableAccountId })}
        >
          <option value="">{t('fields.payableAccountDefault')}</option>
          {payable.map(account => (
            <option key={account.id} value={account.id}>
              {account.code} · {account.name}
            </option>
          ))}
        </SelectField>
      )}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={pending || !changed}>
          {supplier === null ? t('create') : t('save')}
        </Button>
      </div>
    </form>
  )
}
