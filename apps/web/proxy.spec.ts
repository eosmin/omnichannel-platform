import { NextRequest } from 'next/server'

import { proxy } from './proxy'

jest.mock('./lib/env', () => ({
  isDevelopment: false,
  isProduction: true,
  webEnv: {
    NEXT_PUBLIC_API_URL: 'https://api.example.com',
    NEXT_PUBLIC_WS_URL: 'https://api.example.com'
  }
}))

const CSP_HEADER = 'content-security-policy'
const SESSION = { cookie: '__Host-platform_refresh=token' }

function nonceOf(policy: string | null): string {
  const nonce = policy?.match(/'nonce-([^']+)'/)?.[1]
  if (nonce === undefined) throw new Error('the policy has no nonce')
  return nonce
}

describe('proxy', () => {
  it('sets the policy on the response and hands the same one to Next on the request', () => {
    const response = proxy(
      new NextRequest('https://app.example.com/no-access', { headers: SESSION })
    )
    const policy = response.headers.get(CSP_HEADER)
    expect(policy).toContain("script-src 'self'")
    // NextResponse.next({ request }) lists the request headers it overrides
    expect(response.headers.get('x-middleware-override-headers')).toContain(CSP_HEADER)
    expect(response.headers.get(`x-middleware-request-${CSP_HEADER}`)).toBe(policy)
  })

  it('uses a new nonce for every request', () => {
    const first = proxy(new NextRequest('https://app.example.com/', { headers: SESSION }))
    const second = proxy(new NextRequest('https://app.example.com/', { headers: SESSION }))
    expect(nonceOf(first.headers.get(CSP_HEADER))).not.toBe(nonceOf(second.headers.get(CSP_HEADER)))
  })

  it('ignores a policy that the client sent', () => {
    const request = new NextRequest('https://app.example.com/', {
      headers: { ...SESSION, [CSP_HEADER]: "script-src 'unsafe-inline'" }
    })
    expect(proxy(request).headers.get(CSP_HEADER)).not.toContain("script-src 'unsafe-inline'")
  })

  it('sends a visitor with no session to the login page', () => {
    const response = proxy(new NextRequest('https://app.example.com/s/abc/inbox'))
    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/login')
  })

  it('lets a visitor with no session open the login page, with the policy', () => {
    const response = proxy(new NextRequest('https://app.example.com/login'))
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get(CSP_HEADER)).toContain("script-src 'self'")
  })

  it('sends a person with a session from the login page to the start', () => {
    const response = proxy(new NextRequest('https://app.example.com/login', { headers: SESSION }))
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/')
  })

  it('does not take the cookie of development for a session in production', () => {
    const response = proxy(
      new NextRequest('https://app.example.com/', { headers: { cookie: 'platform_refresh=token' } })
    )
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/login')
  })
})
