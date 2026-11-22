'use client'

import { useTranslations } from 'next-intl'
import { type ComponentType, type ReactElement, useState } from 'react'

import { COOKIE_PREFERENCES_OPEN_EVENT } from '@platform/core/cookie-consent'

import { toast } from '../../lib/toast'
import { Button } from '../ui/button'

import type { CookieConsentUiProps } from './cookie-consent-ui'

// Opens the panel of cookie preferences: the person can change the choice whenever they want, not only when the banner shows.
// When the page has a banner (a visitor who has something to answer), its gate answers the event; when it has none (the visitor
// already answered, so the page ships none of that code), the panel is fetched here, on the first click.
export function CookiePreferencesButton(): ReactElement {
  const t = useTranslations('cookieConsent')
  const [Standalone, setStandalone] = useState<ComponentType<CookieConsentUiProps> | null>(null)
  const [loading, setLoading] = useState(false)
  const open = (): void => {
    const notHandled = window.dispatchEvent(
      new Event(COOKIE_PREFERENCES_OPEN_EVENT, { cancelable: true })
    )
    // A panel this button already loaded listens to the event itself
    if (!notHandled || Standalone !== null) return
    setLoading(true)
    import('./cookie-consent-ui')
      .then(
        module => setStandalone(() => module.default),
        // The chunk did not arrive (offline, a deploy replaced it): the person is told and the next click tries again
        () => toast.error(t('panelLoadFailed'))
      )
      .finally(() => setLoading(false))
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={open} disabled={loading} aria-busy={loading}>
        {t('openPreferences')}
      </Button>
      {Standalone === null ? null : <Standalone openPanelOnMount />}
    </>
  )
}
