'use client'

import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { useEffect } from 'react'

import { localeToAdopt, writeLocaleCookie } from '../../lib/account/locale-cookie'

// A browser with no language of its own takes the one the person saved in their account, once; the
// language of a browser that already has a cookie is the person's choice for that device
export function LocaleSync({ savedLocale }: { savedLocale: string }): null {
  const shown = useLocale()
  const router = useRouter()
  useEffect(() => {
    const next = localeToAdopt(document.cookie, savedLocale, shown)
    if (next === null) return
    writeLocaleCookie(next)
    router.refresh()
  }, [savedLocale, shown, router])
  return null
}
