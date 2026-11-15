import { NextResponse, type NextRequest } from 'next/server'

import { AppPaths } from '@platform/api-client'
import { PluginWidgetFrames } from '@platform/core/domain'

import { isDevelopment, isProduction, webEnv } from './lib/env'
import { frameCookieName, parseFrameOrigins, storeIdOfPath } from './lib/plugin-frames'
import { refreshCookieName } from './lib/refresh-cookie'
import { accessFor, RouteAccess } from './lib/route-access'
import { buildContentSecurityPolicy } from './lib/security-headers'

const CSP_HEADER = 'Content-Security-Policy'

// The widget origins the cookie of the store in the path names, and only those that are not the platform's own. A
// page that is not a store's has none, and `frame-src` stays 'none'.
function frameOriginsOf(request: NextRequest): string[] {
  const storeId = storeIdOfPath(request.nextUrl.pathname)
  if (storeId === null) return []
  const value = request.cookies.get(frameCookieName(storeId))?.value
  // The same hosts the api refuses (the web app, the api, the widget script) and the ones the browser used to reach this
  // server: behind a reverse proxy `nextUrl.origin` can be an internal address, so the forwarded host counts too
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  return parseFrameOrigins(value, [
    request.nextUrl.origin,
    ...(forwardedHost === null ? [] : [`https://${forwardedHost.split(',')[0]?.trim() ?? ''}`]),
    webEnv.NEXT_PUBLIC_API_URL,
    webEnv.NEXT_PUBLIC_WS_URL,
    webEnv.NEXT_PUBLIC_STORAGE_URL,
    webEnv.NEXT_PUBLIC_WIDGET_SCRIPT_URL
  ])
}

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
  const frameOrigins = frameOriginsOf(request)
  const policy = buildContentSecurityPolicy({
    nonce,
    apiUrl: webEnv.NEXT_PUBLIC_API_URL,
    wsUrl: webEnv.NEXT_PUBLIC_WS_URL,
    storageUrl: webEnv.NEXT_PUBLIC_STORAGE_URL,
    sentryDsn: webEnv.NEXT_PUBLIC_SENTRY_DSN,
    isDev: isDevelopment,
    frameOrigins
  })

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(CSP_HEADER, policy)
  // Always set on the pages the proxy runs for, so a header a client sent does not reach them (a prefetch skips the
  // proxy; there the page re-reads the value with `parseFrameOrigins` and it only ever concerns that browser)
  requestHeaders.set(PluginWidgetFrames.ORIGINS_HEADER, frameOrigins.join(' '))
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set(CSP_HEADER, policy)
  return response
}

export const config = {
  matcher: [
    {
      // Pages only: not the static files, the image optimizer, the service worker (/serwist/sw.js and its map, which
      // a browser fetches with no page around it) or a prefetch of next/link. A matcher must be a
      // literal, so the path is written here and not read from lib/push.
      source: '/((?!_next/static|_next/image|favicon.ico|serwist/sw\\.js).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' }
      ]
    }
  ]
}
