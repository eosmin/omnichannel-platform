'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, type ReactNode, useState } from 'react'

import { dayOfClock } from '../../lib/finance/dates'
import {
  balanceSheetQueryOf,
  defaultRange,
  flowQueryOf,
  type StatementRangeDraft,
  type StatementRangeProblem,
  statementDayProblem,
  statementRangeProblem
} from '../../lib/finance/statement-form'
import { Button } from '../ui/button'

import { TextField } from './fields'

// The question of a statement of a range of days, and of one of a day. The answer is asked when the person says so (the button), not on
// every keystroke: a statement is a read of the whole ledger. A day that is not a real day of the calendar is said first, with the
// rules of the api.

export function RangeFilters({
  onApply,
  children
}: {
  onApply: (query: { from: string; to: string }) => void
  // What sits beside the button once an answer is on screen (the file)
  children?: ReactNode
}): ReactElement {
  const t = useTranslations('finance.statementsCommon')
  const [draft, setDraft] = useState<StatementRangeDraft>(() => defaultRange(new Date()))
  const [wrong, setWrong] = useState<StatementRangeProblem | null>(null)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = statementRangeProblem(draft)
    setWrong(problem)
    if (problem === null) onApply(flowQueryOf(draft))
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t('formLabel')}
      className="grid items-start gap-3 sm:grid-cols-[1fr_1fr_auto]"
    >
      <TextField
        label={t('from')}
        type="date"
        value={draft.from}
        maxLength={10}
        problem={
          wrong === 'from' ? t('problems.from') : wrong === 'order' ? t('problems.order') : null
        }
        onChange={from => {
          setDraft(current => ({ ...current, from }))
          setWrong(null)
        }}
      />
      <TextField
        label={t('to')}
        type="date"
        value={draft.to}
        maxLength={10}
        problem={wrong === 'to' ? t('problems.to') : null}
        onChange={to => {
          setDraft(current => ({ ...current, to }))
          setWrong(null)
        }}
      />
      <div className="flex flex-wrap items-center gap-2 sm:pt-[22px]">
        <Button type="submit" size="sm" data-testid="finance-report-show">
          {t('show')}
        </Button>
        {children}
      </div>
    </form>
  )
}

export function DayFilters({
  onApply,
  extra,
  children
}: {
  onApply: (query: { asOf: string }) => void
  // A field of its own beside the day (the list with age asks which one)
  extra?: ReactNode
  children?: ReactNode
}): ReactElement {
  const t = useTranslations('finance.statementsCommon')
  const [day, setDay] = useState(() => dayOfClock(new Date()))
  const [wrong, setWrong] = useState(false)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = statementDayProblem(day)
    setWrong(problem)
    if (!problem) onApply(balanceSheetQueryOf(day))
  }
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t('formLabel')}
      className="grid items-start gap-3 sm:grid-cols-[1fr_1fr_auto]"
    >
      {extra ?? <span className="hidden sm:block" />}
      <TextField
        label={t('asOf')}
        type="date"
        value={day}
        maxLength={10}
        problem={wrong ? t('problems.day') : null}
        onChange={value => {
          setDay(value)
          setWrong(false)
        }}
      />
      <div className="flex flex-wrap items-center gap-2 sm:pt-[22px]">
        <Button type="submit" size="sm" data-testid="finance-report-show">
          {t('show')}
        </Button>
        {children}
      </div>
    </form>
  )
}
