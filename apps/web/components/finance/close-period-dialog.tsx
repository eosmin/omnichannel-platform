'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { FinancePeriodView } from '@platform/api-client'

import { closePhraseMatches, closePhraseOf } from '../../lib/finance/report-form'
import { useCloseFinancePeriod } from '../../lib/finance/use-finance-reports'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// Closing a month freezes it (TDD_18 §5.1): the dialog says what that does before it asks, and the person types the month to agree.
// The api checks every rule again (the month has ended, the one before is closed, nothing waits to be posted, the books balance) and
// the dialog shows its answer as it is.
export function ClosePeriodDialog({
  period,
  endsOnText,
  open,
  onOpenChange
}: {
  period: FinancePeriodView
  // The last day of the month, written in the language of the person
  endsOnText: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.periods.close')
  const { storeId } = useStore()
  // Here and not in the form: the form goes away with the dialog, and the answer of a close that is running must still be heard
  const close = useCloseFinancePeriod(storeId)
  return (
    <Dialog
      open={open}
      onOpenChange={next => (next || !close.isPending ? onOpenChange(next) : undefined)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title', { month: closePhraseOf(period) })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <CloseForm
            period={period}
            endsOnText={endsOnText}
            close={close}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CloseForm({
  period,
  endsOnText,
  close,
  onDone
}: {
  period: FinancePeriodView
  endsOnText: string
  close: ReturnType<typeof useCloseFinancePeriod>
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.periods.close')
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const phraseId = useId()
  const [typed, setTyped] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const phrase = closePhraseOf(period)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!closePhraseMatches(typed, period) || !guard.enter()) return
    setRefusal(null)
    close.mutate(period.id, {
      onSuccess: () => {
        toast.success(t('done', { month: phrase }))
        onDone()
      },
      onError: error => setRefusal(errorText(error)),
      onSettled: guard.leave
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <ul
        className="flex list-disc flex-col gap-1 pl-5 text-sm"
        data-testid="finance-close-effects"
      >
        <li>{t('effects.locked', { date: endsOnText })}</li>
        <li>{t('effects.reports')}</li>
        <li>{t('effects.reopen')}</li>
      </ul>
      <div className="grid gap-1.5">
        <Label htmlFor={phraseId}>{t('phraseLabel', { phrase })}</Label>
        <Input
          id={phraseId}
          autoComplete="off"
          value={typed}
          placeholder={phrase}
          disabled={close.isPending}
          onChange={event => {
            setTyped(event.target.value)
            setRefusal(null)
          }}
        />
      </div>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onDone} disabled={close.isPending}>
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={close.isPending || !closePhraseMatches(typed, period)}
          busy={close.isPending}
        >
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
