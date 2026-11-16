'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { FinancePeriodView } from '@platform/api-client'
import { FinanceLimits } from '@platform/core/domain'

import {
  closePhraseOf,
  reopenInputOf,
  type ReopenReasonProblem,
  reopenReasonProblem
} from '../../lib/finance/report-form'
import { useReopenFinancePeriod } from '../../lib/finance/use-finance-reports'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { TextField } from './fields'

// Reopening the latest closed month (TDD_18 §5.3): the books of that month can change again, and the reason typed here is the trail of
// why. The api refuses any month but the latest closed one; the dialog shows its answer as it is.
export function ReopenPeriodDialog({
  period,
  open,
  onOpenChange
}: {
  period: FinancePeriodView
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.periods.reopen')
  const { storeId } = useStore()
  // Here and not in the form: the form goes away with the dialog, and the answer of a reopen that is running must still be heard
  const reopen = useReopenFinancePeriod(storeId)
  return (
    <Dialog
      open={open}
      onOpenChange={next => (next || !reopen.isPending ? onOpenChange(next) : undefined)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title', { month: closePhraseOf(period) })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <ReopenForm period={period} reopen={reopen} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ReopenForm({
  period,
  reopen,
  onDone
}: {
  period: FinancePeriodView
  reopen: ReturnType<typeof useReopenFinancePeriod>
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.periods.reopen')
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const [reason, setReason] = useState('')
  const [wrong, setWrong] = useState<ReopenReasonProblem | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = reopenReasonProblem(reason)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    setRefusal(null)
    reopen.mutate(
      { periodId: period.id, ...reopenInputOf(reason) },
      {
        onSuccess: () => {
          toast.success(t('done', { month: closePhraseOf(period) }))
          onDone()
        },
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <ul
        className="flex list-disc flex-col gap-1 pl-5 text-sm"
        data-testid="finance-reopen-effects"
      >
        <li>{t('effects.entries')}</li>
        <li>{t('effects.audit')}</li>
      </ul>
      <TextField
        label={t('reason')}
        value={reason}
        maxLength={FinanceLimits.REOPEN_REASON_MAX_LENGTH}
        disabled={reopen.isPending}
        hint={t('reasonHint')}
        problem={wrong === null ? null : t(`problems.${wrong}`)}
        onChange={next => {
          setReason(next)
          setWrong(null)
          setRefusal(null)
        }}
      />
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onDone} disabled={reopen.isPending}>
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={reopen.isPending}
          busy={reopen.isPending}
        >
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
