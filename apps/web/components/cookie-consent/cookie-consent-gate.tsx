'use client'

import { type ComponentType, type ReactElement, useEffect, useState } from 'react'

import { COOKIE_PREFERENCES_OPEN_EVENT } from '@platform/core/domain'

import { isSettled } from '../../lib/cookie-consent/cookie-choice'

import type { CookieConsentUiProps } from './cookie-consent-ui'

// This sits in every screen of the app, so the check that almost always ends it is one `includes` on the cookie header, and the
// banner and its panel are a chunk fetched only when there is something to draw: a visitor who has not answered, a choice that was
// made for an older policy text, a choice the api does not have yet, or a button that asks for the panel. It is imported by hand
// and not with `next/dynamic`, which throws in render when the chunk cannot be loaded: a banner must never take the page down.
export function CookieConsentGate(): ReactElement | null {
  const [Loaded, setLoaded] = useState<ComponentType<CookieConsentUiProps> | null>(null)
  const [requested, setRequested] = useState(false)
  const [panelFirst, setPanelFirst] = useState(false)
  // A button asks again after a chunk that did not arrive
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!isSettled(document.cookie)) setRequested(true)
    const onOpen = (): void => {
      setPanelFirst(true)
      setRequested(true)
      setAttempt(count => count + 1)
    }
    window.addEventListener(COOKIE_PREFERENCES_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(COOKIE_PREFERENCES_OPEN_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (!requested || Loaded !== null) return
    let current = true
    import('./cookie-consent-ui').then(
      module => {
        if (current) setLoaded(() => module.default)
      },
      // The chunk did not arrive (offline, a deploy replaced it): the page works and the next one asks again
      () => undefined
    )
    return () => {
      current = false
    }
  }, [requested, Loaded, attempt])

  return Loaded === null ? null : <Loaded openPanelOnMount={panelFirst} />
}
