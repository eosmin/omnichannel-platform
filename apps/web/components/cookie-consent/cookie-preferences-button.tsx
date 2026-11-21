'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { COOKIE_PREFERENCES_OPEN_EVENT } from '@platform/core/domain'

import { Button } from '../ui/button'

// Opens the panel of cookie preferences from anywhere: the person can change the choice whenever they want, not only when the
// banner shows
export function CookiePreferencesButton(): ReactElement {
  const t = useTranslations('cookieConsent')
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => window.dispatchEvent(new Event(COOKIE_PREFERENCES_OPEN_EVENT))}
    >
      {t('openPreferences')}
    </Button>
  )
}
