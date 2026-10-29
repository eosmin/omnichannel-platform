import { NextResponse, type NextRequest } from 'next/server'

import { AppPaths } from '@platform/api-client'

import { isDevelopment, isProduction, webEnv } from './lib/env'
import { refreshCookieName } from './lib/refresh-cookie'
import { accessFor, RouteAccess } from './lib/route-access'
import { buildContentSecurityPolicy } from './lib/security-headers'

const CSP_HEADER = 'Content-Security-Policy'

// Sets the Content-Security-Policy with a nonce for each request. Next reads the nonce from the
// request header and puts it on its own scripts. It also sends who has no session to the login and
// who has one away from it, by the presence of the cookie only: the api decides whether the session
// is valid, and a dead cookie is cleared by the refresh that finds it dead.
export function proxy(request: NextRequest): NextResponse {
  const hasSession = request.cookies.has(refreshCookieName(isProduction))
  const access = accessFor(request.nextUrl.pathname, hasSession)
  if (access !== RouteAccess.ALLOW) {
    const target = access === RouteAccess.TO_LOGIN ? AppPaths.login : '/'
    return NextResponse.redirect(new URL(target, request.url))
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const policy = buildContentSecurityPolicy({
    nonce,
    apiUrl: webEnv.NEXT_PUBLIC_API_URL,
    wsUrl: webEnv.NEXT_PUBLIC_WS_URL,
    sentryDsn: webEnv.NEXT_PUBLIC_SENTRY_DSN,
    isDev: isDevelopment
  })

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(CSP_HEADER, policy)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set(CSP_HEADER, policy)
  return response
}

export const config = {
  matcher: [
    {
      // Pages only: not the static files, the image optimizer or a prefetch of next/link
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' }
      ]
    }
  ]
}
