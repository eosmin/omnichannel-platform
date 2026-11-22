import { COOKIE_CONSENT_COOKIE_NAME, COOKIE_POLICY_VERSION } from '@platform/core/cookie-consent'

import {
  ALL_ALLOWED,
  choiceCookie,
  currentChoice,
  encodeChoice,
  isCategoryAllowed,
  NONE_ALLOWED,
  parseStoredChoice,
  type CookieChoice
} from './cookie-choice'
import { isSettled } from './cookie-settled'

const ID = '3f2b8c1e-0a4d-4f6e-9b1a-7c5d2e8f9a10'
const choice = (patch: Partial<CookieChoice> = {}): CookieChoice => ({
  visitorId: ID,
  categories: { functional: true, analytics: false, marketing: true },
  synced: true,
  policyVersion: COOKIE_POLICY_VERSION,
  ...patch
})
const header = (value: string): string =>
  `a=1; ${COOKIE_CONSENT_COOKIE_NAME}=${encodeURIComponent(value)}; b=2`

describe('the cookie of the choice', () => {
  it('round-trips through the cookie header', () => {
    const written = choiceCookie(choice(), false).split(';')[0] ?? ''
    expect(parseStoredChoice(`x=1; ${written}`)).toEqual(choice())
  })

  it('marks the cookie Secure on https only, and never HttpOnly (the page reads it)', () => {
    expect(choiceCookie(choice(), true)).toContain('; Secure')
    expect(choiceCookie(choice(), false)).not.toContain('Secure')
    expect(choiceCookie(choice(), true)).not.toContain('HttpOnly')
    expect(choiceCookie(choice(), true)).toContain('SameSite=Lax')
  })

  it.each([
    ['no cookie', 'a=1; b=2'],
    ['a value that is not ours', header('hello')],
    ['a missing visitor id', header(`${COOKIE_POLICY_VERSION}.1.101`)],
    ['a visitor id that is not a uuid', header(`${COOKIE_POLICY_VERSION}.1.101.abc`)],
    ['bits of the wrong length', header(`${COOKIE_POLICY_VERSION}.1.10.${ID}`)],
    ['a synced flag that is not 0 or 1', header(`${COOKIE_POLICY_VERSION}.2.101.${ID}`)],
    ['extra parts', header(`${COOKIE_POLICY_VERSION}.1.101.${ID}.x`)]
  ])('reads %s as no choice', (_name, cookies) => {
    expect(parseStoredChoice(cookies)).toBeNull()
    expect(currentChoice(cookies)).toBeNull()
  })

  it('reads a malformed percent escape as no choice instead of throwing', () => {
    expect(parseStoredChoice(`${COOKIE_CONSENT_COOKIE_NAME}=%E0%A4%A`)).toBeNull()
  })

  it('does not take a cookie of another name that ends the same way', () => {
    expect(parseStoredChoice(`x${COOKIE_CONSENT_COOKIE_NAME}=${encodeChoice(choice())}`)).toBeNull()
  })

  it('asks again when the policy version changed, and keeps the old choice readable for its visitor id', () => {
    const old = header(encodeChoice(choice({ policyVersion: '2020-01-01' })))
    expect(currentChoice(old)).toBeNull()
    expect(parseStoredChoice(old)?.visitorId).toBe(ID)
  })

  it('is settled only when current and already sent', () => {
    expect(isSettled(header(encodeChoice(choice())))).toBe(true)
    expect(isSettled(header(encodeChoice(choice({ synced: false }))))).toBe(false)
    expect(isSettled(header(encodeChoice(choice({ policyVersion: '2020-01-01' }))))).toBe(false)
    expect(isSettled('a=1')).toBe(false)
    expect(isSettled(`x${COOKIE_CONSENT_COOKIE_NAME}=${COOKIE_POLICY_VERSION}.1.101.${ID}`)).toBe(
      false
    )
  })

  it('is not settled by a cookie that only starts like a choice (forged or cut), so the banner asks again', () => {
    const prefix = `${COOKIE_POLICY_VERSION}.1.`
    for (const value of [
      prefix,
      `${prefix}junk`,
      `${prefix}101`,
      `${prefix}10.${ID}`,
      `${prefix}1011.${ID}`,
      `${prefix}101.not-a-visitor-id`,
      `${prefix}101.${ID}.extra`,
      `${prefix}101.${ID.toUpperCase()}`
    ]) {
      expect(isSettled(header(value))).toBe(false)
      // What the page draws and what a feature may do never disagree: a cookie that settles the page is one that parses whole
      expect(currentChoice(header(value))).toBeNull()
    }
    expect(isSettled(header(encodeChoice(choice())))).toBe(true)
  })

  it('agrees with the parser: whatever settles the page is a current, synced choice', () => {
    const settled = header(encodeChoice(choice()))
    expect(isSettled(settled)).toBe(true)
    expect(currentChoice(settled)?.synced).toBe(true)
  })

  it('allows a category only when the person said yes: no answer is a no', () => {
    const cookies = header(encodeChoice(choice()))
    expect(isCategoryAllowed(cookies, 'functional')).toBe(true)
    expect(isCategoryAllowed(cookies, 'analytics')).toBe(false)
    expect(isCategoryAllowed('', 'functional')).toBe(false)
    expect(
      isCategoryAllowed(header(encodeChoice(choice({ policyVersion: '2020-01-01' }))), 'functional')
    ).toBe(false)
  })

  it('has an all-yes and an all-no set that cover every choosable category', () => {
    expect(Object.values(ALL_ALLOWED).every(Boolean)).toBe(true)
    expect(Object.values(NONE_ALLOWED).some(Boolean)).toBe(false)
  })
})
