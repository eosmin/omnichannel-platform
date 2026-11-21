import { COOKIE_CONSENT_COOKIE_NAME, COOKIE_POLICY_VERSION } from '@platform/core/domain'

// The check every page makes, with no parsing: the choice is current and the api has it, so there is nothing to draw. It lives
// apart from the rest of the cookie code, which is loaded only when there is something to draw (the script budget of every page
// counts what the gate imports).
export function isSettled(cookieHeader: string): boolean {
  return `; ${cookieHeader}`.includes(`; ${COOKIE_CONSENT_COOKIE_NAME}=${COOKIE_POLICY_VERSION}.1.`)
}
