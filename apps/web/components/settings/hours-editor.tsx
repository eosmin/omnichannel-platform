'use client'

import { Copy, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId } from 'react'

import { SettingsLimits, type Weekday, Weekdays } from '@platform/core/domain'

import {
  addRange,
  copyDay,
  WORKING_DAYS,
  type HoursProblem,
  removeRange,
  setRange,
  timeOptions
} from '../../lib/settings/hours-form'
import type { WeekSchedule } from '../../lib/settings/hours-requests'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

const WEEKDAYS: readonly Weekday[] = Weekdays.slice(0, WORKING_DAYS)

// The seven days of the week, each closed or with up to four ranges of hours (TDD_09 §13). Times are
// chosen by the quarter of an hour. The problems are the ones found before saving, by day.
export function HoursEditor({
  schedule,
  problems,
  disabled,
  onChange
}: {
  schedule: WeekSchedule
  problems: Partial<Record<Weekday, HoursProblem[]>>
  disabled: boolean
  onChange: (next: WeekSchedule) => void
}): ReactElement {
  const t = useTranslations('settings.hours')
  const idPrefix = useId()
  return (
    <ul aria-label={t('weekLabel')} className="flex flex-col gap-3">
      {Weekdays.map(day => {
        const ranges = schedule[day]
        const dayName = t(`days.${day}`)
        const dayProblems = problems[day] ?? []
        return (
          <li key={day} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">{dayName}</h2>
              <div className="flex items-center gap-2">
                {!disabled && day === Weekdays[0] ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onChange(copyDay(schedule, day, WEEKDAYS))}
                  >
                    <Copy aria-hidden className="size-4" />
                    {t('copyWeekdays')}
                  </Button>
                ) : null}
                {!disabled && ranges.length < SettingsLimits.MAX_RANGES_PER_DAY ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onChange(addRange(schedule, day))}
                  >
                    <Plus aria-hidden className="size-4" />
                    {t('addRange')}
                    <span className="sr-only"> {dayName}</span>
                  </Button>
                ) : null}
              </div>
            </div>
            {ranges.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('closed')}</p>
            ) : (
              ranges.map((range, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <div className="grid grid-cols-1 gap-1">
                    <Label htmlFor={`${idPrefix}-${day}-${index}-from`}>
                      {t('from')}
                      <span className="sr-only"> {dayName}</span>
                    </Label>
                    <select
                      id={`${idPrefix}-${day}-${index}-from`}
                      className={SELECT_CLASS}
                      value={range.from}
                      disabled={disabled}
                      onChange={event =>
                        onChange(
                          setRange(schedule, day, index, { ...range, from: event.target.value })
                        )
                      }
                    >
                      {timeOptions(range.from, false).map(time => (
                        <option key={time} value={time}>
                          {time}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-1 gap-1">
                    <Label htmlFor={`${idPrefix}-${day}-${index}-to`}>
                      {t('to')}
                      <span className="sr-only"> {dayName}</span>
                    </Label>
                    <select
                      id={`${idPrefix}-${day}-${index}-to`}
                      className={SELECT_CLASS}
                      value={range.to}
                      disabled={disabled}
                      onChange={event =>
                        onChange(
                          setRange(schedule, day, index, { ...range, to: event.target.value })
                        )
                      }
                    >
                      {timeOptions(range.to, true).map(time => (
                        <option key={time} value={time}>
                          {time}
                        </option>
                      ))}
                    </select>
                  </div>
                  {disabled ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onChange(removeRange(schedule, day, index))}
                      aria-label={t('removeRange', { day: dayName, number: index + 1 })}
                    >
                      <X aria-hidden className="size-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
            {dayProblems.map(problem => (
              <p key={problem} role="alert" className="text-destructive text-sm">
                {t(`problems.${problem}`, { day: dayName })}
              </p>
            ))}
          </li>
        )
      })}
    </ul>
  )
}
