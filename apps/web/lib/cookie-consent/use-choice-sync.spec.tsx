/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'

import { COOKIE_CONSENT_COOKIE_NAME, COOKIE_POLICY_VERSION } from '@platform/core/cookie-consent'

import { type CookieChoice, encodeChoice } from './cookie-choice'
import { sameChoice, useChoiceSync } from './use-choice-sync'

const choice = (patch: Partial<CookieChoice> = {}): CookieChoice => ({
  visitorId: '3f2b8c1e-0a4d-4f6e-9b1a-7c5d2e8f9a10',
  categories: { functional: false, analytics: false, marketing: false },
  synced: true,
  policyVersion: COOKIE_POLICY_VERSION,
  ...patch
})
const writeCookie = (value: CookieChoice | null): void => {
  document.cookie =
    value === null
      ? `${COOKIE_CONSENT_COOKIE_NAME}=; Max-Age=0; Path=/`
      : `${COOKIE_CONSENT_COOKIE_NAME}=${encodeURIComponent(encodeChoice(value))}; Path=/`
}
const setVisibility = (state: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

describe('useChoiceSync', () => {
  afterEach(() => {
    writeCookie(null)
    setVisibility('visible')
  })

  // PRI-191: the second tab kept its banner after the first one answered
  it('hands over the answer another tab wrote when this one gets the focus back', () => {
    const onChange = jest.fn()
    renderHook(() => useChoiceSync(onChange))
    writeCookie(choice())
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(choice())
  })

  it('reads the cookie when the tab becomes visible, and not while it goes hidden', () => {
    const onChange = jest.fn()
    renderHook(() => useChoiceSync(onChange))
    writeCookie(choice())
    setVisibility('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(onChange).not.toHaveBeenCalled()
    setVisibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(onChange).toHaveBeenCalledWith(choice())
  })

  it('says null when the cookie holds no answer, and stops listening once unmounted', () => {
    const onChange = jest.fn()
    const { unmount } = renderHook(() => useChoiceSync(onChange))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(onChange).toHaveBeenCalledWith(null)
    unmount()
    onChange.mockClear()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('sameChoice', () => {
  it('is the same answer when the visitor, the policy, the sync mark and every category agree', () => {
    expect(sameChoice(choice(), choice())).toBe(true)
    expect(sameChoice(null, null)).toBe(true)
  })

  it.each([
    [
      'a category',
      choice({ categories: { functional: true, analytics: false, marketing: false } })
    ],
    ['the sync mark', choice({ synced: false })],
    ['the visitor', choice({ visitorId: '4f2b8c1e-0a4d-4f6e-9b1a-7c5d2e8f9a10' })],
    ['the policy', choice({ policyVersion: 'other' })],
    ['an answer', null]
  ])('is another answer when %s differs', (_name, other) => {
    expect(sameChoice(choice(), other)).toBe(false)
  })
})
