import { COOKIE_CONSENT_COOKIE_NAME, COOKIE_POLICY_VERSION } from '@platform/core/cookie-consent'

import { WEB_URL } from './env'

// A visitor that already answered the cookie banner (everything optional off, and the api has the answer): the specs that are not
// about the banner open the app with this cookie so that the banner does not stand over what they click. The spec of the banner
// removes it. Same value as `lib/cookie-consent/cookie-choice.ts` writes: version, synced, one bit per category, visitor id.
export const ANSWERED_VISITOR_ID = '00000000-0000-4000-8000-00000000e2e0'

export const answeredCookieConsent = {
  name: COOKIE_CONSENT_COOKIE_NAME,
  value: encodeURIComponent(`${COOKIE_POLICY_VERSION}.1.000.${ANSWERED_VISITOR_ID}`),
  domain: new URL(WEB_URL).hostname,
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: 'Lax' as const
}
