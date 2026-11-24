'use client'

import { useEffect } from 'react'

import { ChoosableCookieCategories } from '@platform/core/cookie-consent'

import { type CookieChoice, currentChoice } from './cookie-choice'

export const sameChoice = (a: CookieChoice | null, b: CookieChoice | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.visitorId === b.visitorId &&
    a.policyVersion === b.policyVersion &&
    a.synced === b.synced &&
    ChoosableCookieCategories.every(category => a.categories[category] === b.categories[category]))

// The answer lives in a cookie that every tab of the browser shares, but a cookie tells no tab when it changes. A tab that was in the
// background when another one answered kept its banner until a reload (PRI-191); it reads the cookie again when it is looked at.
// `onChange` gets what the cookie holds (null when nothing was answered); the caller keeps the state it already has when it is the same.
export function useChoiceSync(onChange: (choice: CookieChoice | null) => void): void {
  useEffect(() => {
    const read = (): void => onChange(currentChoice(document.cookie))
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') read()
    }
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [onChange])
}
