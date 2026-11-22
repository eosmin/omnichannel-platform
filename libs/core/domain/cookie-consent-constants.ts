export const CookieCategories = {
  NECESSARY: 'necessary', // No consent required
  FUNCTIONAL: 'functional', // Language, last store
  ANALYTICS: 'analytics', // Product usage
  MARKETING: 'marketing' // Not used currently
} as const

// A new version re-prompts the cookie consent.
// PROVISIONAL: the version of the policy text the owner approves replaces this value (plan, Step 7.2-D, debt b)
export const COOKIE_POLICY_VERSION = '2026-09-01'

// The cookie the browser keeps the choice in (TDD_05 §10.5). Not a secret and not HttpOnly: the page reads it to know whether
// to ask again.
export const COOKIE_CONSENT_COOKIE_NAME = 'platform_cc'
// One year, the longest a choice stays before the banner asks again whatever the policy version.
export const COOKIE_CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

// The categories a person can choose. `necessary` is always on and is not a choice, so it is not a key of the stored value.
export const ChoosableCookieCategories = [
  CookieCategories.FUNCTIONAL,
  CookieCategories.ANALYTICS,
  CookieCategories.MARKETING
] as const
export type ChoosableCookieCategory = (typeof ChoosableCookieCategories)[number]

// The page-level event that opens the panel of preferences from any button of the app (the banner is a chunk loaded only when it is needed)
export const COOKIE_PREFERENCES_OPEN_EVENT = 'platform:cookie-preferences-open'
