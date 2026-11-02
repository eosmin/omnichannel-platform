'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useMemo } from 'react'

import { OrganizationLimits } from '@platform/core/domain'
import { LocaleLabels, SUPPORTED_LOCALES } from '@platform/core/i18n'

import {
  intlValues,
  type StoreFormProblems,
  type StoreFormValues,
  withCurrent
} from '../../lib/settings/store-form'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// The four fields of a store, for the General page and for the dialog that creates one. The problems
// are the ones found before sending; what the api refuses is shown by the caller.
export function StoreFields({
  values,
  problems,
  disabled,
  onChange
}: {
  values: StoreFormValues
  problems: StoreFormProblems
  disabled: boolean
  onChange: (next: StoreFormValues) => void
}): ReactElement {
  const t = useTranslations('settings.store')
  const id = useId()
  const timezones = useMemo(
    () => withCurrent(intlValues('timeZone'), values.timezone),
    [values.timezone]
  )
  const currencies = useMemo(
    () => withCurrent(intlValues('currency'), values.currency),
    [values.currency]
  )
  const set = (key: keyof StoreFormValues, value: string): void =>
    onChange({ ...values, [key]: value })
  const problemText = (key: keyof StoreFormValues): ReactElement | null => {
    const problem = problems[key]
    return problem === undefined ? null : (
      <p id={`${id}-${key}-problem`} role="alert" className="text-destructive text-sm">
        {t(`problems.${problem}`)}
      </p>
    )
  }
  const describedBy = (key: keyof StoreFormValues): string | undefined =>
    problems[key] === undefined ? undefined : `${id}-${key}-problem`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>{t('name')}</Label>
        <Input
          id={`${id}-name`}
          value={values.name}
          maxLength={OrganizationLimits.NAME_MAX_LENGTH}
          disabled={disabled}
          aria-invalid={problems.name !== undefined}
          aria-describedby={describedBy('name')}
          onChange={event => set('name', event.target.value)}
        />
        {problemText('name')}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-timezone`}>{t('timezone')}</Label>
        <select
          id={`${id}-timezone`}
          className={SELECT_CLASS}
          value={values.timezone}
          disabled={disabled}
          onChange={event => set('timezone', event.target.value)}
        >
          {timezones.map(zone => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-currency`}>{t('currency')}</Label>
        <select
          id={`${id}-currency`}
          className={SELECT_CLASS}
          value={values.currency}
          disabled={disabled}
          aria-invalid={problems.currency !== undefined}
          aria-describedby={describedBy('currency')}
          onChange={event => set('currency', event.target.value)}
        >
          {currencies.map(code => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        {problemText('currency')}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-locale`}>{t('defaultLocale')}</Label>
        <select
          id={`${id}-locale`}
          className={SELECT_CLASS}
          value={values.defaultLocale}
          disabled={disabled}
          aria-invalid={problems.defaultLocale !== undefined}
          aria-describedby={describedBy('defaultLocale')}
          onChange={event => set('defaultLocale', event.target.value)}
        >
          {SUPPORTED_LOCALES.map(locale => (
            <option key={locale} value={locale}>
              {LocaleLabels[locale]}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-xs">{t('defaultLocaleHint')}</p>
        {problemText('defaultLocale')}
      </div>
    </div>
  )
}
