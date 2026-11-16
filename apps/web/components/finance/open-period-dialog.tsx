'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import {
  type OpenPeriodDraft,
  type OpenPeriodField,
  OpenPeriodFields,
  openPeriodDraftOf,
  openPeriodInputOf,
  openPeriodProblem
} from '../../lib/finance/period-form'
import { useOpenFinancePeriod } from '../../lib/finance/use-finance'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { TextField } from './fields'

// Opens the period of a month before any entry needs it (TDD_18 §3): a month that is already open answers with that period.
export function OpenPeriodDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.periods.open')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? <OpenPeriodForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function OpenPeriodForm({ onDone }: { onDone: () => void }): ReactElement {
  const t = useTranslations('finance.periods.open')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const open = useOpenFinancePeriod(storeId)
  const [draft, setDraft] = useState<OpenPeriodDraft>(() => openPeriodDraftOf(new Date()))
  const [wrong, setWrong] = useState<OpenPeriodField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const set = (patch: Partial<OpenPeriodDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = openPeriodProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    open.mutate(openPeriodInputOf(draft), {
      onSuccess: () => {
        toast.success(t('done'))
        onDone()
      },
      onError: error => setRefusal(errorText(error)),
      onSettled: guard.leave
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('month')}
          value={draft.month}
          inputMode="numeric"
          maxLength={2}
          disabled={open.isPending}
          problem={wrong === OpenPeriodFields.MONTH ? t('problems.month') : null}
          onChange={month => set({ month })}
        />
        <TextField
          label={t('year')}
          value={draft.year}
          inputMode="numeric"
          maxLength={4}
          disabled={open.isPending}
          problem={wrong === OpenPeriodFields.YEAR ? t('problems.year') : null}
          onChange={year => set({ year })}
        />
      </div>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={open.isPending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={open.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
