'use client'

import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { useEffect } from 'react'

import { LOCALE_COOKIE } from '@platform/api-client'

// A browser with no language of its own takes the one the person saved in their account, once; the
// language of a browser that already has a cookie is the person's choice for that device.
// This sits in every screen of the app, so the check that almost always ends it is inline and the
// rest of the logic is loaded only when it can matter (the script budget of the inbox is tight).
export function LocaleSync({ savedLocale }: { savedLocale: string }): null {
  const shown = useLocale()
  const router = useRouter()
  useEffect(() => {
    if (savedLocale === shown || document.cookie.includes(`${LOCALE_COOKIE}=`)) return
    void import('../../lib/account/locale-cookie').then(({ localeToAdopt, writeLocaleCookie }) => {
      const next = localeToAdopt(document.cookie, savedLocale, shown)
      if (next === null) return
      writeLocaleCookie(next)
      router.refresh()
    })
  }, [savedLocale, shown, router])
  return null
}
