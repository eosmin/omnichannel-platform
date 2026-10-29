import { AppPaths } from '@platform/api-client'

export const RouteAccess = { ALLOW: 'allow', TO_LOGIN: 'to-login', TO_START: 'to-start' } as const
export type RouteAccessResult = (typeof RouteAccess)[keyof typeof RouteAccess]

const SESSION_HANDLERS_PREFIX = '/auth/'
const INVITATIONS_PREFIX = '/invitations/'

// Pages that make sense with no session: the invitation page is where a person with no account
// starts, and the handlers of the session answer for themselves. Everything else needs the cookie.
// The cookie says only that a session may exist: the api decides whether it does.
function isPublic(pathname: string): boolean {
  return (
    pathname === AppPaths.login ||
    pathname === AppPaths.magicLink ||
    pathname.startsWith(INVITATIONS_PREFIX) ||
    pathname.startsWith(SESSION_HANDLERS_PREFIX)
  )
}

export function accessFor(pathname: string, hasSessionCookie: boolean): RouteAccessResult {
  if (hasSessionCookie) {
    return pathname === AppPaths.login ? RouteAccess.TO_START : RouteAccess.ALLOW
  }
  return isPublic(pathname) ? RouteAccess.ALLOW : RouteAccess.TO_LOGIN
}
