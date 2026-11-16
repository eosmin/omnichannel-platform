'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useMemo, useState } from 'react'

import type { FinanceSetupView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { isCalendarDay } from '../../lib/finance/dates'
import { useSetUpFinance } from '../../lib/finance/use-finance'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { SelectField, TextField } from './fields'

// The books of an organization are set up once (TDD_18 §3): the country picks the chart to start from, and the date is the first day
// events are posted from. Only who manages the accounts can do it; the rest are told who can.
export function SetupPanel({ state }: { state: FinanceSetupView }): ReactElement {
  const t = useTranslations('finance.setup')
  const { storeId, can } = useStore()
  const canSetUp = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const locale = useLocale()
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const setUp = useSetUpFinance(storeId)
  const [country, setCountry] = useState(state.countries[0] ?? '')
  const [startsOn, setStartsOn] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const [dateWrong, setDateWrong] = useState(false)
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: 'region' }), [locale])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (country === '') return
    if (startsOn !== '' && !isCalendarDay(startsOn)) {
      setDateWrong(true)
      return
    }
    if (!guard.enter()) return
    setUp.mutate(
      { countryCode: country, ...(startsOn === '' ? {} : { accountingStartDate: startsOn }) },
      {
        onSuccess: () => toast.success(t('done')),
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      {!canSetUp ? (
        <p className="text-muted-foreground text-sm">{t('askAdmin')}</p>
      ) : state.countries.length === 0 ? (
        <p role="alert" className="text-destructive text-sm">
          {t('noCountries')}
        </p>
      ) : (
        <form
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-3"
          aria-label={t('formLabel')}
        >
          <SelectField
            label={t('country')}
            value={country}
            hint={t('countryHint')}
            disabled={setUp.isPending}
            onChange={value => {
              setCountry(value)
              setRefusal(null)
            }}
          >
            {state.countries.map(code => (
              <option key={code} value={code}>
                {names.of(code) ?? code}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('startsOn')}
            value={startsOn}
            hint={t('startsOnHint')}
            problem={dateWrong ? t('startsOnProblem') : null}
            disabled={setUp.isPending}
            onChange={value => {
              setStartsOn(value)
              setDateWrong(false)
              setRefusal(null)
            }}
          />
          {refusal === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {refusal}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={setUp.isPending || country === ''}>
              {t('submit')}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
