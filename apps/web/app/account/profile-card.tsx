'use client'

import { useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { useProfile } from '../../lib/use-profile'

// Read-only for now: the api has no route to change the profile yet
export function ProfileCard(): ReactElement | null {
  const t = useTranslations('account')
  const uiLocale = useLocale()
  const { data: profile } = useProfile()
  if (profile === undefined) return null
  const rows: [string, string][] = [
    [t('name'), profile.name],
    [t('email'), profile.email],
    [t('language'), languageName(profile.locale, uiLocale)],
    [t('timezone'), profile.timezone ?? t('notSet')]
  ]
  return (
    <section className="mx-auto flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('profileTitle')}</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// "es" shown as "español" in the language of the page; a code the runtime does not know stays as it is
function languageName(code: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
