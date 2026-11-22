import {
  ChoosableCookieCategories,
  COOKIE_CONSENT_COOKIE_NAME,
  COOKIE_POLICY_VERSION
} from '@platform/core/cookie-consent'

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

// The whole shape of a cookie this version wrote and the api has (`<version>.1.<one bit per category>.<visitor id>`), and nothing else:
// a cookie with only the prefix is not a settled choice. Fixed-length parts and no nested quantifier, so it cannot backtrack.
const SETTLED = new RegExp(
  `(?:^|; )${escaped(COOKIE_CONSENT_COOKIE_NAME)}=${escaped(COOKIE_POLICY_VERSION)}\\.1\\.[01]{${ChoosableCookieCategories.length}}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=;|$)`
)

// The check every page makes, with no parsing: the choice is current, whole and already sent, so there is nothing to draw. A cookie
// that only starts like one (forged or cut) is not settled: the banner asks again, and the page and the check of a category
// (`isCategoryAllowed`, which parses the whole value) agree about what is in the browser. It lives apart from the rest of the cookie
// code, which is loaded only when there is something to draw (the script budget of every page counts what the gate imports).
export function isSettled(cookieHeader: string): boolean {
  return SETTLED.test(cookieHeader)
}
