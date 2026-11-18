'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { FinanceAccountView } from '@platform/api-client'

import { accountLabelsOf, postableAccountsOf } from '../../lib/finance/account-form'
import { dayOfClock } from '../../lib/finance/dates'
import {
  attemptMayHavePosted,
  emptyManualEntryDraft,
  type ManualEntryDraft,
  ManualEntryEntryTypes,
  ManualEntryFields,
  isFooterProblem,
  type ManualEntryProblem,
  manualEntryInputOf,
  manualEntryProblem,
  manualEntryTotals,
  type ManualLineDraft,
  newManualLine
} from '../../lib/finance/manual-entry-form'
import { usePostManualFinanceEntry } from '../../lib/finance/use-finance'
import { useMoney } from '../../lib/finance/use-money'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  stickyDialogActionsClass
} from '../ui/dialog'

import { SelectField, TextField } from './fields'

// An entry a person writes (TDD_18 §4.2, E13): free lines that balance, and the reason. It cannot be edited or erased afterwards, only
// reversed, so the store's confirmation is asked before it is sent (POST_MANUAL_ENTRY, the HIGH tier). The amounts are dollars typed and
// whole cents sent; the accounts offered are the ones that post and are on.
export function ManualEntryDialog({
  accounts,
  open,
  onOpenChange
}: {
  accounts: readonly FinanceAccountView[]
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.manual')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Only Cancel closes it: a request in flight is never left without its form (and its key) */}
      <DialogContent
        className="sm:max-w-2xl"
        onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <ManualEntryForm
            accounts={accounts}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const newKey = (): string => crypto.randomUUID()

function ManualEntryForm({
  accounts,
  onDone,
  onCancel
}: {
  accounts: readonly FinanceAccountView[]
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const t = useTranslations('finance.manual')
  const errorText = useErrorText()
  const money = useMoney()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const run = useDestructiveAction()
  const post = usePostManualFinanceEntry(storeId)
  const [draft, setDraft] = useState<ManualEntryDraft>(() =>
    emptyManualEntryDraft(dayOfClock(new Date()), [newKey(), newKey()])
  )
  // The key of the form: a double click or a retry after a lost answer is the same entry. It is renewed by an edit only until an
  // attempt may have posted (the answer was lost); from then on the form is locked, so a retry is the same entry under the same key
  // (answered with the first if it posted) and an edit cannot make it a second one (HC-114). A refusal after that does not unlock it.
  const [key, setKey] = useState(newKey)
  const [mayHavePosted, setMayHavePosted] = useState(false)
  const [wrong, setWrong] = useState<ManualEntryProblem | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const locked = saving || mayHavePosted
  const label = accountLabelsOf(accounts)
  const options = postableAccountsOf(
    accounts,
    draft.lines.map(line => line.accountId)
  )
  const totals = manualEntryTotals(draft.lines)
  const difference = totals.debitCents - totals.creditCents

  const change = (next: ManualEntryDraft): void => {
    setDraft(next)
    if (!mayHavePosted) setKey(newKey())
    setWrong(null)
    setRefusal(null)
  }
  const setLine = (index: number, patch: Partial<ManualLineDraft>): void =>
    change({
      ...draft,
      lines: draft.lines.map((line, at) => (at === index ? { ...line, ...patch } : line))
    })

  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setSaving(true)
    try {
      const posted = await post.mutateAsync(manualEntryInputOf(draft, key))
      toast.success(t('done', { number: posted.number }))
      onDone()
    } catch (error) {
      if (attemptMayHavePosted(error)) setMayHavePosted(true)
      setRefusal(errorText(error))
    } finally {
      setSaving(false)
      guard.leave()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = manualEntryProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    run('POST_MANUAL_ENTRY', {
      title: t('confirmTitle'),
      description: t('confirmDescription'),
      confirmLabel: t('confirm'),
      onConfirm: send
    })
  }

  const problemOf = (
    field: typeof ManualEntryFields.DATE | typeof ManualEntryFields.MEMO
  ): string | null => (wrong?.field === field ? t(`problems.${field}`) : null)

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('date')}
          type="date"
          value={draft.entryDate}
          disabled={locked}
          problem={problemOf(ManualEntryFields.DATE)}
          onChange={entryDate => change({ ...draft, entryDate })}
        />
        <SelectField
          label={t('type')}
          value={draft.type}
          disabled={locked}
          onChange={type => change({ ...draft, type })}
        >
          {ManualEntryEntryTypes.map(type => (
            <option key={type} value={type}>
              {t(`types.${type}`)}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField
        label={t('memo')}
        value={draft.memo}
        maxLength={500}
        disabled={locked}
        hint={t('memoHint')}
        problem={problemOf(ManualEntryFields.MEMO)}
        onChange={memo => change({ ...draft, memo })}
      />
      <fieldset className="flex flex-col gap-3" data-testid="finance-manual-lines">
        <legend className="mb-1 text-sm font-medium">{t('lines')}</legend>
        {draft.lines.map((line, index) => (
          <div
            key={line.key}
            className="flex flex-col gap-2 rounded-md border p-3"
            data-testid="finance-manual-line"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t('line', { number: index + 1 })}</span>
              {draft.lines.length > 2 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={locked}
                  aria-label={t('removeLine', { number: index + 1 })}
                  onClick={() =>
                    change({ ...draft, lines: draft.lines.filter((_, at) => at !== index) })
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
            <SelectField
              label={t('account', { number: index + 1 })}
              value={line.accountId}
              disabled={locked}
              problem={
                wrong?.field === ManualEntryFields.LINE && wrong.index === index
                  ? t('problems.line', { number: index + 1 })
                  : null
              }
              onChange={accountId => setLine(index, { accountId })}
            >
              <option value="">{t('pickAccount')}</option>
              {options.map(account => (
                <option key={account.id} value={account.id}>
                  {label(account.id)}
                </option>
              ))}
            </SelectField>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label={t('debit', { number: index + 1 })}
                value={line.debit}
                inputMode="decimal"
                maxLength={13}
                disabled={locked}
                onChange={debit => setLine(index, { debit })}
              />
              <TextField
                label={t('credit', { number: index + 1 })}
                value={line.credit}
                inputMode="decimal"
                maxLength={13}
                disabled={locked}
                onChange={credit => setLine(index, { credit })}
              />
            </div>
            <TextField
              label={t('lineMemo', { number: index + 1 })}
              value={line.memo}
              maxLength={500}
              disabled={locked}
              onChange={memo => setLine(index, { memo })}
            />
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => change({ ...draft, lines: [...draft.lines, newManualLine(newKey())] })}
          >
            <Plus aria-hidden />
            {t('addLine')}
          </Button>
        </div>
      </fieldset>
      <dl className="grid grid-cols-3 gap-2 text-sm" data-testid="finance-manual-totals">
        <div>
          <dt className="text-muted-foreground text-xs">{t('totals.debit')}</dt>
          <dd className="tabular-nums">{money(totals.debitCents)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t('totals.credit')}</dt>
          <dd className="tabular-nums">{money(totals.creditCents)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t('totals.difference')}</dt>
          <dd className="tabular-nums">{money(Math.abs(difference))}</dd>
        </div>
      </dl>
      {wrong !== null && isFooterProblem(wrong.field) ? (
        <p role="alert" className="text-destructive text-sm">
          {t(`problems.${wrong.field}`)}
        </p>
      ) : null}
      {mayHavePosted ? (
        <p role="status" className="text-sm">
          {t('maybePosted')}
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className={`${stickyDialogActionsClass} flex justify-end gap-2`}>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={saving} busy={saving}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
