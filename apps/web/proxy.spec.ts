import { NextRequest } from 'next/server'

import { config, proxy } from './proxy'

jest.mock('./lib/env', () => ({
  isDevelopment: false,
  isProduction: true,
  webEnv: {
    NEXT_PUBLIC_API_URL: 'https://api.example.com',
    NEXT_PUBLIC_WS_URL: 'https://api.example.com',
    NEXT_PUBLIC_STORAGE_URL: 'https://files.example.com',
    NEXT_PUBLIC_WIDGET_SCRIPT_URL: 'https://cdn.widget-example.com/widget.js'
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

  describe('frame-src per store', () => {
    const STORE = '0b8f6a52-3d1c-4c8e-9a47-5e2f1d7c9b10'
    const OTHER = '9c1d3e44-7a52-4b0f-8e61-2a4b6c8d0e12'
    const cookieFor = (id: string, origins: string) =>
      `platform_widget_frames_${id}=${encodeURIComponent(origins)}`
    const frameSrc = (policy: string | null) =>
      policy?.split('; ').find(part => part.startsWith('frame-src'))

    it('allows the origins of the widgets of the store in the path, for that response only', () => {
      const request = new NextRequest(`https://app.example.com/s/${STORE}/inbox`, {
        headers: {
          cookie: `${SESSION.cookie}; ${cookieFor(STORE, 'https://widgets.acme.example')}`
        }
      })
      const response = proxy(request)
      expect(frameSrc(response.headers.get(CSP_HEADER))).toBe(
        'frame-src https://widgets.acme.example'
      )
      expect(response.headers.get('x-middleware-request-x-plugin-frame-origins')).toBe(
        'https://widgets.acme.example'
      )
    })

    it("keeps 'none' on a store whose cookie is another store's", () => {
      const request = new NextRequest(`https://app.example.com/s/${OTHER}/inbox`, {
        headers: {
          cookie: `${SESSION.cookie}; ${cookieFor(STORE, 'https://widgets.acme.example')}`
        }
      })
      expect(frameSrc(proxy(request).headers.get(CSP_HEADER))).toBe("frame-src 'none'")
    })

    it("keeps 'none' outside the pages of a store, whatever cookie is there", () => {
      const request = new NextRequest('https://app.example.com/account/profile', {
        headers: {
          cookie: `${SESSION.cookie}; ${cookieFor(STORE, 'https://widgets.acme.example')}`
        }
      })
      expect(frameSrc(proxy(request).headers.get(CSP_HEADER))).toBe("frame-src 'none'")
    })

    it('never frames the platform itself, nor a sibling host of it, nor plain http', () => {
      const forged =
        'https://app.example.com https://api.example.com https://plugins.example.com http://widgets.acme.example https://widgets.acme.example'
      const request = new NextRequest(`https://app.example.com/s/${STORE}/inbox`, {
        headers: { cookie: `${SESSION.cookie}; ${cookieFor(STORE, forged)}` }
      })
      expect(frameSrc(proxy(request).headers.get(CSP_HEADER))).toBe(
        'frame-src https://widgets.acme.example'
      )
    })

    it('never frames the host the browser used, the widget script host, nor a forwarded public host', () => {
      const forged =
        'https://cdn.widget-example.com https://public.platform-example.org https://widgets.acme.example'
      const request = new NextRequest(`http://localhost:3000/s/${STORE}/inbox`, {
        headers: {
          cookie: `${SESSION.cookie}; ${cookieFor(STORE, forged)}`,
          'x-forwarded-host': 'public.platform-example.org'
        }
      })
      expect(frameSrc(proxy(request).headers.get(CSP_HEADER))).toBe(
        'frame-src https://widgets.acme.example'
      )
    })

    it('overwrites a frame-origins header the client sent', () => {
      const request = new NextRequest(`https://app.example.com/s/${STORE}/inbox`, {
        headers: { ...SESSION, 'x-plugin-frame-origins': 'https://evil.example' }
      })
      expect(proxy(request).headers.get('x-middleware-request-x-plugin-frame-origins')).toBe('')
    })
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

  it('leaves the service worker out of what it runs on, so its fetch is never sent to the login', () => {
    const first = config.matcher[0]
    const pattern = new RegExp(`^${first?.source ?? ''}$`)
    expect(pattern.test('/serwist/sw.js')).toBe(false)
    expect(pattern.test('/serwist/sw.js.map')).toBe(false)
    // Only the worker is left out, not whatever else sits under the same prefix
    expect(pattern.test('/serwist/other')).toBe(true)
    expect(pattern.test('/serwist-x')).toBe(true)
    expect(pattern.test('/s/abc/inbox')).toBe(true)
  })
})
