'use client'

import { type ComponentType, type ReactElement, useEffect, useState } from 'react'

import { COOKIE_PREFERENCES_OPEN_EVENT } from '@platform/core/cookie-consent'

import type { CookieConsentUiProps } from './cookie-consent-ui'

// The layout draws this only for a visitor who has something to answer (no answer yet, an answer for an older policy text, or one the
// api does not have yet: `isSettled` on the cookie header, on the server), so a visitor who already answered ships none of this code.
// The banner and its panel are a chunk fetched by hand and not with `next/dynamic`, which throws in render when the chunk cannot be
// loaded: a banner must never take the page down. A button that asks for the panel is answered here (`preventDefault` tells it
// so); a failed load is tried again on the next ask.
export function CookieConsentGate(): ReactElement | null {
  const [Loaded, setLoaded] = useState<ComponentType<CookieConsentUiProps> | null>(null)
  const [panelFirst, setPanelFirst] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const onOpen = (event: Event): void => {
      event.preventDefault()
      setPanelFirst(true)
      setAttempt(count => count + 1)
    }
    window.addEventListener(COOKIE_PREFERENCES_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(COOKIE_PREFERENCES_OPEN_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (Loaded !== null) return
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
  }, [Loaded, attempt])

  return Loaded === null ? null : <Loaded openPanelOnMount={panelFirst} />
}
