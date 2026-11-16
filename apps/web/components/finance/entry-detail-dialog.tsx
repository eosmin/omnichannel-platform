'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, type ReactNode, useState } from 'react'

import type { FinanceAccountView, FinanceEntryDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { FinanceSourceType, JournalEntryType } from '@platform/core/domain'

import { isCalendarDay } from '../../lib/finance/dates'
import { useFinanceEntry, useReverseFinanceEntry } from '../../lib/finance/use-finance'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { EntryLines } from './entry-lines'
import { TextField } from './fields'

// One entry of the journal with its lines (TDD_18 §4.2). Who may write entries (`finance:post_manual`) can reverse it, once: a reversal
// is another entry that stays in the journal next to this one. An entry that belongs to a transaction is voided through the transaction.
export function EntryDetailDialog({
  entryId,
  accounts,
  onOpenChange
}: {
  entryId: string | null
  accounts: readonly FinanceAccountView[]
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { storeId } = useStore()
  const entry = useFinanceEntry(storeId, entryId)
  const t = useTranslations('finance.entry')
  return (
    <Dialog open={entryId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {entry.data === undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('titleLoading')}</DialogTitle>
              <DialogDescription>{t('loading')}</DialogDescription>
            </DialogHeader>
            {entry.isError ? (
              <LoadFailed error={entry.error} onRetry={() => void entry.refetch()} />
            ) : (
              <PageLoading />
            )}
          </>
        ) : (
          <EntryBody entry={entry.data} accounts={accounts} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function EntryBody({
  entry,
  accounts,
  onClose
}: {
  entry: FinanceEntryDetailView
  accounts: readonly FinanceAccountView[]
  onClose: () => void
}): ReactElement {
  const t = useTranslations('finance.entry')
  const tTypes = useTranslations('finance.entryTypes')
  const format = useFormatter()
  const { can } = useStore()
  const [reversing, setReversing] = useState(false)
  const isReversal = entry.type === String(JournalEntryType.REVERSAL)
  const reversed = entry.reversedByEntryId !== null
  const ownedByTransaction = entry.sourceType === String(FinanceSourceType.FINANCE_TRANSACTION)
  const canReverse =
    can(ClientPermissions.FINANCE_POST_MANUAL) && !isReversal && !reversed && !ownedByTransaction

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title', { number: entry.number })}</DialogTitle>
        <DialogDescription>{t('description', { date: entry.entryDate })}</DialogDescription>
      </DialogHeader>
      <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="finance-entry-detail">
        <Fact label={t('fields.type')}>{tTypes(entry.type as 'manual')}</Fact>
        <Fact label={t('fields.origin')}>{t(`origins.${entry.origin as 'user'}`)}</Fact>
        <Fact label={t('fields.memo')}>{entry.memo ?? ''}</Fact>
        {entry.sourceType === null ? null : (
          <Fact label={t('fields.source')}>{t(`sources.${entry.sourceType as 'order'}`)}</Fact>
        )}
        <Fact label={t('fields.createdAt')}>
          {format.dateTime(new Date(entry.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </Fact>
      </dl>
      <EntryLines lines={entry.lines} accounts={accounts} />
      {reversed ? <p className="text-sm">{t('reversed')}</p> : null}
      {entry.reversesEntryId === null ? null : <p className="text-sm">{t('reverses')}</p>}
      {ownedByTransaction && !reversed ? (
        <p className="text-muted-foreground text-sm">{t('belongsToTransaction')}</p>
      ) : null}
      {reversing ? (
        <ReverseForm entry={entry} onDone={onClose} onCancel={() => setReversing(false)} />
      ) : (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
          {canReverse ? (
            <Button type="button" onClick={() => setReversing(true)}>
              {t('reverse.action')}
            </Button>
          ) : null}
        </div>
      )}
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  )
}

type ReverseProblem = 'memo' | 'date'

function ReverseForm({
  entry,
  onDone,
  onCancel
}: {
  entry: FinanceEntryDetailView
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const t = useTranslations('finance.entry.reverse')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const run = useDestructiveAction()
  const reverse = useReverseFinanceEntry(storeId)
  const [memo, setMemo] = useState('')
  const [date, setDate] = useState('')
  const [wrong, setWrong] = useState<ReverseProblem | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setSaving(true)
    try {
      await reverse.mutateAsync({
        id: entry.id,
        memo: memo.trim(),
        ...(date === '' ? {} : { entryDate: date })
      })
      toast.success(t('done'))
      onDone()
    } catch (error) {
      setRefusal(errorText(error))
    } finally {
      setSaving(false)
      guard.leave()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (memo.trim() === '') {
      setWrong('memo')
      return
    }
    if (date !== '' && !isCalendarDay(date)) {
      setWrong('date')
      return
    }
    run('REVERSE_ENTRY', {
      title: t('confirmTitle', { number: entry.number }),
      description: t('confirmDescription'),
      confirmLabel: t('confirm'),
      onConfirm: send
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <p className="text-sm font-medium">{t('title', { number: entry.number })}</p>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <TextField
        label={t('memo')}
        value={memo}
        maxLength={500}
        disabled={saving}
        problem={wrong === 'memo' ? t('problems.memo') : null}
        onChange={value => {
          setMemo(value)
          setWrong(null)
          setRefusal(null)
        }}
      />
      <TextField
        label={t('date')}
        type="date"
        value={date}
        disabled={saving}
        hint={t('dateHint')}
        problem={wrong === 'date' ? t('problems.date') : null}
        onChange={value => {
          setDate(value)
          setWrong(null)
          setRefusal(null)
        }}
      />
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
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
