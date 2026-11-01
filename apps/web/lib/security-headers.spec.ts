import {
  buildContentSecurityPolicy,
  CUSTOMER_AVATAR_IMAGE_HOSTS,
  STATIC_SECURITY_HEADERS
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

  it('draws images only from the app, inline data and the avatar hosts of Meta', () => {
    const img = directive(buildContentSecurityPolicy(options), 'img-src')
    expect(img).toBe(
      `img-src 'self' data: blob: https://files.example.com ${CUSTOMER_AVATAR_IMAGE_HOSTS.join(' ')}`
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

describe('STATIC_SECURITY_HEADERS', () => {
  it('sets the four headers that do not change per request, once each', () => {
    const keys = STATIC_SECURITY_HEADERS.map(header => header.key)
    expect(keys).toEqual([
      'Strict-Transport-Security',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'Permissions-Policy'
    ])
  })
})
