import { NextResponse, type NextRequest } from 'next/server'

import { isDevelopment, webEnv } from './lib/env'
import { buildContentSecurityPolicy } from './lib/security-headers'

const CSP_HEADER = 'Content-Security-Policy'

// Sets the Content-Security-Policy with a nonce for each request. Next reads the nonce from the
// request header and puts it on its own scripts. Auth redirects and referral attribution join
// this file with the auth flow (Step 3.1, C); today it has no session to read.
export function proxy(request: NextRequest): NextResponse {
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
