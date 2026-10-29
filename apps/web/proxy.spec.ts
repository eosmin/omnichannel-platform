import { NextRequest } from 'next/server'

import { proxy } from './proxy'

jest.mock('./lib/env', () => ({
  isDevelopment: false,
  webEnv: {
    NEXT_PUBLIC_API_URL: 'https://api.example.com',
    NEXT_PUBLIC_WS_URL: 'https://api.example.com'
  }
}))

const CSP_HEADER = 'content-security-policy'

function nonceOf(policy: string | null): string {
  const nonce = policy?.match(/'nonce-([^']+)'/)?.[1]
  if (nonce === undefined) throw new Error('the policy has no nonce')
  return nonce
}

describe('proxy', () => {
  it('sets the policy on the response and hands the same one to Next on the request', () => {
    const response = proxy(new NextRequest('https://app.example.com/no-access'))
    const policy = response.headers.get(CSP_HEADER)
    expect(policy).toContain("script-src 'self'")
    // NextResponse.next({ request }) lists the request headers it overrides
    expect(response.headers.get('x-middleware-override-headers')).toContain(CSP_HEADER)
    expect(response.headers.get(`x-middleware-request-${CSP_HEADER}`)).toBe(policy)
  })

  it('uses a new nonce for every request', () => {
    const first = proxy(new NextRequest('https://app.example.com/'))
    const second = proxy(new NextRequest('https://app.example.com/'))
    expect(nonceOf(first.headers.get(CSP_HEADER))).not.toBe(nonceOf(second.headers.get(CSP_HEADER)))
  })

  it('ignores a policy that the client sent', () => {
    const request = new NextRequest('https://app.example.com/', {
      headers: { [CSP_HEADER]: "script-src 'unsafe-inline'" }
    })
    expect(proxy(request).headers.get(CSP_HEADER)).not.toContain("script-src 'unsafe-inline'")
  })
})
