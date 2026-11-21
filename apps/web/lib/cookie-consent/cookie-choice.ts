import {
  ChoosableCookieCategories,
  type ChoosableCookieCategory,
  COOKIE_CONSENT_COOKIE_MAX_AGE_SECONDS,
  COOKIE_CONSENT_COOKIE_NAME,
  COOKIE_POLICY_VERSION
} from '@platform/core/domain'

// What the browser remembers about the cookie banner, in the one cookie `platform_cc` (it is the record that the person
// answered, so it is the only thing written before an answer exists: nothing is written until the person chooses).
// Value: `<policy version>.<synced 0|1>.<one 0|1 per choosable category, in order>.<visitor id>`; the version comes first so that a
// page can tell with one `includes` that the choice is current and already sent (see `isSettled`).
export interface CookieChoice {
  visitorId: string
  categories: Record<ChoosableCookieCategory, boolean>
  // The api has the answer. A choice that is not synced stays in the browser and is sent again on a later page.
  synced: boolean
  policyVersion: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BITS = new RegExp(`^[01]{${ChoosableCookieCategories.length}}$`)

export function encodeChoice(choice: CookieChoice): string {
  const bits = ChoosableCookieCategories.map(category => (choice.categories[category] ? '1' : '0'))
  return [choice.policyVersion, choice.synced ? '1' : '0', bits.join(''), choice.visitorId].join(
    '.'
  )
}

function valueIn(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const item = part.trim()
    if (item.startsWith(`${COOKIE_CONSENT_COOKIE_NAME}=`)) {
      try {
        return decodeURIComponent(item.slice(COOKIE_CONSENT_COOKIE_NAME.length + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

// The choice the cookie holds, of any version, or null when there is none or it was edited into something that is not one
export function parseStoredChoice(cookieHeader: string): CookieChoice | null {
  const value = valueIn(cookieHeader)
  if (value === null) return null
  const [policyVersion, synced, bits, visitorId, ...rest] = value.split('.')
  if (
    rest.length > 0 ||
    policyVersion === undefined ||
    policyVersion === '' ||
    (synced !== '0' && synced !== '1') ||
    bits === undefined ||
    !BITS.test(bits) ||
    visitorId === undefined ||
    !UUID.test(visitorId)
  ) {
    return null
  }
  const categories = Object.fromEntries(
    ChoosableCookieCategories.map((category, index) => [category, bits[index] === '1'])
  ) as Record<ChoosableCookieCategory, boolean>
  return { visitorId, categories, synced: synced === '1', policyVersion }
}

// The choice that rules today: one made for an older policy text is not an answer to this one and the banner asks again
export function currentChoice(cookieHeader: string): CookieChoice | null {
  const stored = parseStoredChoice(cookieHeader)
  return stored !== null && stored.policyVersion === COOKIE_POLICY_VERSION ? stored : null
}

// The check every page makes, with no parsing: the choice is current and the api has it, so there is nothing to draw
export function isSettled(cookieHeader: string): boolean {
  return `; ${cookieHeader}`.includes(`; ${COOKIE_CONSENT_COOKIE_NAME}=${COOKIE_POLICY_VERSION}.1.`)
}

// Whether the person allowed a category. `necessary` is not asked, and no answer is a no: nothing optional is switched on by default.
export function isCategoryAllowed(
  cookieHeader: string,
  category: ChoosableCookieCategory
): boolean {
  return currentChoice(cookieHeader)?.categories[category] === true
}

export function choiceCookie(choice: CookieChoice, secure: boolean): string {
  return `${COOKIE_CONSENT_COOKIE_NAME}=${encodeURIComponent(encodeChoice(choice))}; Path=/; Max-Age=${COOKIE_CONSENT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function writeChoice(choice: CookieChoice): void {
  document.cookie = choiceCookie(choice, window.location.protocol === 'https:')
}

// A visitor keeps the same id across a new policy version, so that the history of what they said is one line
export function newChoice(
  categories: Record<ChoosableCookieCategory, boolean>,
  previous: CookieChoice | null
): CookieChoice {
  return {
    visitorId: previous?.visitorId ?? crypto.randomUUID(),
    categories,
    synced: false,
    policyVersion: COOKIE_POLICY_VERSION
  }
}

export const ALL_ALLOWED = Object.fromEntries(
  ChoosableCookieCategories.map(category => [category, true])
) as Record<ChoosableCookieCategory, boolean>
export const NONE_ALLOWED = Object.fromEntries(
  ChoosableCookieCategories.map(category => [category, false])
) as Record<ChoosableCookieCategory, boolean>
