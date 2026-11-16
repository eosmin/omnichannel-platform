'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { FinanceAccountView } from '@platform/api-client'
import { AccountType, CashKind } from '@platform/core/domain'

import {
  type AccountDraft,
  type AccountField,
  AccountFields,
  accountDraftOf,
  accountProblem,
  canBeCash,
  createAccountInputOf,
  emptyAccountDraft,
  parentOptionsOf,
  updateAccountInputOf
} from '../../lib/finance/account-form'
import { useCreateFinanceAccount, useUpdateFinanceAccount } from '../../lib/finance/use-finance'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField, TextField } from './fields'

// Making and editing an account of the chart (TDD_18 §3). `account` is null to make one. What the books refuse (an account with entries
// that changes type, a header that posts) comes back as a code of the api and is said as it is.
export function AccountDialog({
  account,
  accounts,
  open,
  onOpenChange
}: {
  account: FinanceAccountView | null
  accounts: readonly FinanceAccountView[]
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.accounts.dialog')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{account === null ? t('createTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>
            {account === null ? t('createDescription') : t('editDescription')}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts from what the list holds now */}
        {open ? (
          <AccountForm
            key={account?.id ?? 'new'}
            account={account}
            accounts={accounts}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function AccountForm({
  account,
  accounts,
  onDone
}: {
  account: FinanceAccountView | null
  accounts: readonly FinanceAccountView[]
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.accounts')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const create = useCreateFinanceAccount(storeId)
  const update = useUpdateFinanceAccount(storeId)
  const [draft, setDraft] = useState<AccountDraft>(() =>
    account === null ? emptyAccountDraft() : accountDraftOf(account)
  )
  const [wrong, setWrong] = useState<AccountField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = create.isPending || update.isPending
  const changes = account === null ? null : updateAccountInputOf(account, draft)
  const changed = changes === null || Object.keys(changes).length > 0

  const set = (patch: Partial<AccountDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!changed) return
    const problem = accountProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    const handlers = {
      onError: (error: Error) => setRefusal(errorText(error)),
      onSettled: guard.leave
    }
    if (account === null) {
      create.mutate(createAccountInputOf(draft), {
        ...handlers,
        onSuccess: view => {
          toast.success(t('dialog.created', { name: view.name }))
          onDone()
        }
      })
      return
    }
    update.mutate(
      { id: account.id, changes: changes ?? {} },
      {
        ...handlers,
        onSuccess: () => {
          toast.success(t('dialog.saved'))
          onDone()
        }
      }
    )
  }

  const problemText = (field: AccountField): string | null =>
    wrong === field ? t(`problems.${field}`) : null

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
        autoCapitalize="characters"
        disabled={pending}
        problem={problemText(AccountFields.CODE)}
        hint={t('fields.codeHint')}
        onChange={code => set({ code })}
      />
      <TextField
        label={t('fields.name')}
        value={draft.name}
        maxLength={150}
        disabled={pending}
        problem={problemText(AccountFields.NAME)}
        onChange={name => set({ name })}
      />
      <SelectField
        label={t('fields.type')}
        value={draft.type}
        disabled={pending}
        onChange={type => set({ type, cashKind: canBeCash(type) ? draft.cashKind : '' })}
      >
        {Object.values(AccountType).map(type => (
          <option key={type} value={type}>
            {t(`types.${type}`)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('fields.parent')}
        value={draft.parentId}
        disabled={pending}
        onChange={parentId => set({ parentId })}
      >
        <option value="">{t('fields.noParent')}</option>
        {parentOptionsOf(accounts, account?.id ?? null).map(parent => (
          <option key={parent.id} value={parent.id}>
            {parent.code} · {parent.name}
          </option>
        ))}
      </SelectField>
      {canBeCash(draft.type) ? (
        <SelectField
          label={t('fields.cashKind')}
          value={draft.cashKind}
          disabled={pending}
          problem={problemText(AccountFields.CASH_KIND)}
          hint={t('fields.cashKindHint')}
          onChange={cashKind => set({ cashKind })}
        >
          <option value="">{t('fields.notCash')}</option>
          {Object.values(CashKind).map(kind => (
            <option key={kind} value={kind}>
              {t(`cashKinds.${kind}`)}
            </option>
          ))}
        </SelectField>
      ) : null}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={draft.isPostable}
          disabled={pending}
          onChange={event => set({ isPostable: event.target.checked })}
        />
        <span>
          {t('fields.postable')}
          <span className="text-muted-foreground block text-xs">{t('fields.postableHint')}</span>
        </span>
      </label>
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
          {account === null ? t('dialog.create') : t('dialog.save')}
        </Button>
      </div>
    </form>
  )
}
