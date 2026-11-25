import { AppPaths } from '@platform/core/domain'

import {
  buildContentSecurityPolicy,
  DSR_EXPORT_PAGE_SOURCE,
  DSR_REQUEST_PAGE_SOURCE,
  DSR_VERIFY_PAGE_SOURCE,
  STATIC_SECURITY_HEADERS,
  UNSUBSCRIBE_PAGE_SOURCE
} from './security-headers'

const options = {
  nonce: 'abc123',
  apiUrl: 'https://api.example.com',
  wsUrl: 'https://api.example.com',
  storageUrl: 'https://files.example.com/bucket',
  isDev: false
}

function directive(policy: string, name: string): string {
  const found = policy.split('; ').find(part => part.startsWith(`${name} `) || part === name)
  if (found === undefined) throw new Error(`no ${name} in the policy`)
  return found
}

describe('buildContentSecurityPolicy: frame-src', () => {
  it('writes no origin that could add a directive, whatever the caller passed', () => {
    const policy = buildContentSecurityPolicy({
      ...options,
      frameOrigins: [
        'https://a.example; script-src *',
        'https://*.acme.example',
        'http://plain.example',
        'https://ok.example'
      ]
    })
    expect(directive(policy, 'frame-src')).toBe('frame-src https://ok.example')
    expect(policy).not.toContain('script-src *')
  })

  it("is 'none' with no widget origins", () => {
    expect(directive(buildContentSecurityPolicy(options), 'frame-src')).toBe("frame-src 'none'")
    expect(
      directive(buildContentSecurityPolicy({ ...options, frameOrigins: [] }), 'frame-src')
    ).toBe("frame-src 'none'")
  })

  it('lists the origins of the widgets of the store and only those', () => {
    const policy = buildContentSecurityPolicy({
      ...options,
      frameOrigins: ['https://widgets.acme.example', 'https://panel.other.example']
    })
    expect(directive(policy, 'frame-src')).toBe(
      'frame-src https://widgets.acme.example https://panel.other.example'
    )
    // Nothing else loosens: the app still cannot be framed and scripts keep the nonce
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive(policy, 'default-src')).toBe("default-src 'self'")
  })
})

describe('buildContentSecurityPolicy', () => {
  it('lets scripts run only with the nonce of the request', () => {
    const script = directive(buildContentSecurityPolicy(options), 'script-src')
    expect(script).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'")
  })

  it('allows eval only in development', () => {
    expect(
      directive(buildContentSecurityPolicy({ ...options, isDev: true }), 'script-src')
    ).toContain("'unsafe-eval'")
    expect(buildContentSecurityPolicy(options)).not.toContain('unsafe-eval')
  })

  // The policy of the images as it was before it was generated from the plugins: pinned as text, so that a change
  // in what the plugins declare cannot widen or narrow it without this test being edited on purpose
  it('draws images only from the app, inline data and the hosts the plugins declare, exactly as before', () => {
    expect(directive(buildContentSecurityPolicy(options), 'img-src')).toBe(
      "img-src 'self' data: blob: https://files.example.com https://*.fbcdn.net https://*.cdninstagram.com https://platform-lookaside.fbsbx.com https://lookaside.fbsbx.com"
    )
  })

  it('plays audio and video only from the app and the bucket origin, never its path', () => {
    expect(directive(buildContentSecurityPolicy(options), 'media-src')).toBe(
      "media-src 'self' blob: https://files.example.com"
    )
  })

  it('connects to the api and to its websocket, nothing else', () => {
    const connect = directive(buildContentSecurityPolicy(options), 'connect-src')
    expect(connect).toBe(
      "connect-src 'self' https://api.example.com https://files.example.com wss://api.example.com"
    )
  })

  it('uses ws for an http websocket url and adds the origin of the Sentry dsn', () => {
    const connect = directive(
      buildContentSecurityPolicy({
        ...options,
        apiUrl: 'http://localhost:8080',
        wsUrl: 'http://localhost:8080',
        sentryDsn: 'https://key@o1.ingest.sentry.io/2'
      }),
      'connect-src'
    )
    expect(connect).toBe(
      "connect-src 'self' http://localhost:8080 https://files.example.com ws://localhost:8080 https://o1.ingest.sentry.io"
    )
  })

  it('keeps a wss url secure and never adds a plain ws source for it', () => {
    const connect = directive(
      buildContentSecurityPolicy({ ...options, wsUrl: 'wss://realtime.example.com' }),
      'connect-src'
    )
    expect(connect).toBe(
      "connect-src 'self' https://api.example.com wss://realtime.example.com https://files.example.com"
    )
  })

  it('loads styles, fonts, workers and the manifest from the app only', () => {
    const policy = buildContentSecurityPolicy(options)
    expect(directive(policy, 'style-src')).toBe("style-src 'self' 'unsafe-inline'")
    expect(directive(policy, 'font-src')).toBe("font-src 'self'")
    expect(directive(policy, 'worker-src')).toBe("worker-src 'self'")
    expect(directive(policy, 'manifest-src')).toBe("manifest-src 'self'")
    expect(directive(policy, 'default-src')).toBe("default-src 'self'")
  })

  it('forbids framing, plugins and foreign forms', () => {
    const policy = buildContentSecurityPolicy(options)
    for (const rule of [
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ]) {
      expect(policy).toContain(rule)
    }
  })
})

describe('UNSUBSCRIBE_PAGE_SOURCE', () => {
  it('is the path of the page of the one-click unsubscribe', () => {
    expect(UNSUBSCRIBE_PAGE_SOURCE).toBe(AppPaths.unsubscribe)
  })
})

describe('DSR_VERIFY_PAGE_SOURCE', () => {
  it('is the path of the page that confirms a data request', () => {
    expect(DSR_VERIFY_PAGE_SOURCE).toBe(AppPaths.dsrVerify)
  })
})

describe('DSR_EXPORT_PAGE_SOURCE', () => {
  it('is the path of the page that hands over the file of a data export', () => {
    expect(DSR_EXPORT_PAGE_SOURCE).toBe(AppPaths.dsrExport)
  })
})

describe('DSR_REQUEST_PAGE_SOURCE', () => {
  it('is the path of the public form of data requests', () => {
    expect(DSR_REQUEST_PAGE_SOURCE).toBe(AppPaths.dsrRequest)
  })
})

describe('STATIC_SECURITY_HEADERS', () => {
  it('sets the headers that do not change per request, once each', () => {
    const keys = STATIC_SECURITY_HEADERS.map(header => header.key)
    expect(keys).toEqual([
      'Strict-Transport-Security',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'Permissions-Policy',
      'X-Frame-Options',
      'Cross-Origin-Opener-Policy'
    ])
  })

  it('refuses framing for browsers that ignore frame-ancestors, and cuts the opener handle of other origins', () => {
    const value = (key: string): string | undefined =>
      STATIC_SECURITY_HEADERS.find(header => header.key === key)?.value
    expect(value('X-Frame-Options')).toBe('DENY')
    expect(value('Cross-Origin-Opener-Policy')).toBe('same-origin')
  })
})
