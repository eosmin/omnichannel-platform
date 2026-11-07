'use client'

import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useMemo, useState } from 'react'

import {
  type AccountPreferences,
  type AccountPreferencesPatch,
  StorageKeys
} from '@platform/api-client'
import { UiDensity } from '@platform/core/domain'
import { LocaleLabels, SUPPORTED_LOCALES } from '@platform/core/i18n'

import { MutationError } from '../../components/customers/mutation-error'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { writeLocaleCookie } from '../../lib/account/locale-cookie'
import { intlValues, withCurrent } from '../../lib/settings/store-form'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import {
  useAccountPreferences,
  useSaveAccountPreferences
} from '../../lib/settings/use-settings-data'
import { toast } from '../../lib/toast'

function rememberLanguageSaved(locale: string): void {
  try {
    window.sessionStorage.setItem(StorageKeys.LANGUAGE_SAVED, locale)
  } catch {
    // Without storage the page just does not confirm
  }
}

// True once, when the language saved is the one now shown
function takeLanguageSaved(shown: string): boolean {
  try {
    if (window.sessionStorage.getItem(StorageKeys.LANGUAGE_SAVED) !== shown) return false
    window.sessionStorage.removeItem(StorageKeys.LANGUAGE_SAVED)
    return true
  } catch {
    return false
  }
}

// The value of the time zone select that means "the one of this browser" (the api stores null)
const BROWSER_ZONE = ''

interface Values {
  locale: string
  timezone: string
  density: string
}

const valuesOf = (preferences: AccountPreferences): Values => ({
  locale: preferences.locale,
  timezone: preferences.timezone ?? BROWSER_ZONE,
  density: preferences.density
})

function patchOf(initial: Values, values: Values): AccountPreferencesPatch {
  const patch: AccountPreferencesPatch = {}
  if (values.locale !== initial.locale) patch.locale = values.locale
  if (values.timezone !== initial.timezone) patch.timezone = values.timezone || null
  if (values.density !== initial.density) patch.density = values.density
  return patch
}

// Account → Preferences: language, time zone and density of the person, on every device
export function PreferencesPage(): ReactElement {
  const preferences = useAccountPreferences()
  if (preferences.isError) {
    return <LoadFailed error={preferences.error} onRetry={() => void preferences.refetch()} />
  }
  if (preferences.data === undefined) return <PageLoading />
  return <PreferencesForm saved={preferences.data} />
}

function PreferencesForm({ saved }: { saved: AccountPreferences }): ReactElement {
  const t = useTranslations('account.preferences')
  const tAll = useTranslations()
  const router = useRouter()
  const locale = useLocale()
  const id = useId()
  const save = useSaveAccountPreferences()
  const [initial, setInitial] = useState(() => valuesOf(saved))
  const [values, setValues] = useState(initial)
  const zones = useMemo(
    () => withCurrent(intlValues('timeZone'), values.timezone),
    [values.timezone]
  )
  const densities: readonly { value: string; label: string }[] = [
    { value: UiDensity.COMFORTABLE, label: t('densities.comfortable') },
    { value: UiDensity.COMPACT, label: t('densities.compact') }
  ]
  const patch = patchOf(initial, values)
  const hasChanges = Object.keys(patch).length > 0
  useUnsavedChanges(hasChanges)

  // The page was drawn again in the language just saved: confirm in it, once
  useEffect(() => {
    if (takeLanguageSaved(locale)) toast.success(t('saved'))
  }, [locale, t])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!hasChanges || save.isPending) return
    save.mutate(patch, {
      onSuccess: next => {
        const nextValues = valuesOf(next)
        setInitial(nextValues)
        setValues(nextValues)
        if (patch.locale === undefined) {
          toast.success(t('saved'))
        } else {
          // The server renders in the language of this cookie: write it and draw the page again. The
          // confirmation waits for the new language: said now, it would come in the old one.
          rememberLanguageSaved(next.locale)
          writeLocaleCookie(next.locale)
          router.refresh()
        }
      }
    })
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-locale`}>{t('language')}</Label>
          <select
            id={`${id}-locale`}
            className={SELECT_CLASS}
            value={values.locale}
            disabled={save.isPending}
            onChange={event => setValues({ ...values, locale: event.target.value })}
          >
            {SUPPORTED_LOCALES.map(locale => (
              <option key={locale} value={locale}>
                {LocaleLabels[locale]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-timezone`}>{t('timezone')}</Label>
          <select
            id={`${id}-timezone`}
            className={SELECT_CLASS}
            value={values.timezone}
            disabled={save.isPending}
            onChange={event => setValues({ ...values, timezone: event.target.value })}
          >
            <option value={BROWSER_ZONE}>{t('browserZone')}</option>
            {zones.map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-density`}>{t('density')}</Label>
          <select
            id={`${id}-density`}
            className={SELECT_CLASS}
            value={values.density}
            disabled={save.isPending}
            onChange={event => setValues({ ...values, density: event.target.value })}
          >
            {densities.map(density => (
              <option key={density.value} value={density.value}>
                {density.label}
              </option>
            ))}
          </select>
        </div>
        <MutationError error={save.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={!hasChanges || save.isPending}>
            {tAll('common.save')}
          </Button>
        </div>
      </form>
    </section>
  )
}
