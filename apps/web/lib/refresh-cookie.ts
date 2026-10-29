// The refresh token lives in a cookie that only the Next server reads and writes. In production it
// carries the __Host- prefix, which makes the browser refuse it unless it is Secure, on the whole
// site (Path=/) and with no Domain, so that no sibling subdomain can plant or overwrite it. The
// prefix needs https, so local development over http uses the plain name.
const COOKIE_NAME = 'platform_refresh'
const HOST_PREFIX = '__Host-'

export function refreshCookieName(secure: boolean): string {
  return secure ? `${HOST_PREFIX}${COOKIE_NAME}` : COOKIE_NAME
}

export interface RefreshCookie {
  name: string
  value: string
  httpOnly: true
  secure: boolean
  // Lax keeps the cookie off cross-site POSTs, the CSRF vector of the handlers; the handlers also
  // check the Origin header (lib/same-origin.ts)
  sameSite: 'lax'
  path: '/'
  expires: Date
}

export function refreshCookie(value: string, expiresAt: Date, secure: boolean): RefreshCookie {
  return {
    name: refreshCookieName(secure),
    value,
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt
  }
}
