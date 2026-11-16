'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, type ReactNode, useState } from 'react'

import { dayOfClock } from '../../lib/finance/dates'
import {
  balanceSheetQueryOf,
  type BoundedRange,
  boundedRangeMaxDays,
  boundedRangeProblem,
  defaultRange,
  flowQueryOf,
  type StatementRangeDraft,
  type StatementRangeProblem,
  StatementRangeProblems,
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
  applied,
  bound,
  children
}: {
  onApply: (query: { from: string; to: string }) => void
  // The question on screen now: what sits beside the button (the file) is for that question, so it is hidden while the fields say another
  applied: { from: string; to: string } | null
  // The reports that walk rows (the VAT and the margin) have a longest range, and each says its own
  bound?: BoundedRange
  children?: ReactNode
}): ReactElement {
  const t = useTranslations('finance.statementsCommon')
  const [draft, setDraft] = useState<StatementRangeDraft>(() => defaultRange(new Date()))
  const [wrong, setWrong] = useState<StatementRangeProblem | null>(null)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem =
      bound === undefined ? statementRangeProblem(draft) : boundedRangeProblem(draft, bound)
    setWrong(problem)
    if (problem === null) onApply(flowQueryOf(draft))
  }
  const dirty =
    applied === null || applied.from !== draft.from.trim() || applied.to !== draft.to.trim()
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
          wrong === StatementRangeProblems.FROM
            ? t('problems.from')
            : wrong === StatementRangeProblems.ORDER
              ? t('problems.order')
              : null
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
        problem={
          wrong === StatementRangeProblems.TO
            ? t('problems.to')
            : wrong === StatementRangeProblems.TOO_LONG && bound !== undefined
              ? t('problems.tooLong', { days: boundedRangeMaxDays(bound) })
              : null
        }
        onChange={to => {
          setDraft(current => ({ ...current, to }))
          setWrong(null)
        }}
      />
      <div className="flex flex-wrap items-center gap-2 sm:pt-[22px]">
        <Button type="submit" size="sm" data-testid="finance-report-show">
          {t('show')}
        </Button>
        {dirty ? null : children}
      </div>
    </form>
  )
}

export function DayFilters({
  onApply,
  applied,
  extraDirty = false,
  extra,
  children
}: {
  onApply: (query: { asOf: string }) => void
  // The day on screen now (see `RangeFilters`), and whether the field of `extra` says another question than the one on screen
  applied: string | null
  extraDirty?: boolean
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
  const dirty = applied === null || extraDirty || applied !== day.trim()
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
        {dirty ? null : children}
      </div>
    </form>
  )
}
