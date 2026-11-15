import {
  decodeCookieValue,
  frameCookieName,
  parseFrameOrigins,
  serializeFrameOrigins,
  storeIdOfPath
} from './plugin-frames'
import { buildContentSecurityPolicy } from './security-headers'

const PLATFORM = ['https://app.example.com', 'https://api.example.com']
const STORE = '0b8f6a52-3d1c-4c8e-9a47-5e2f1d7c9b10'

describe('storeIdOfPath', () => {
  it.each([
    [`/s/${STORE}`, STORE],
    [`/s/${STORE}/inbox/abc`, STORE],
    [`/s/${STORE.toUpperCase()}/orders`, STORE]
  ])('reads the store of %s', (path, expected) => {
    expect(storeIdOfPath(path)).toBe(expected)
  })

  it.each([
    '/',
    '/login',
    '/account/profile',
    '/s/not-a-uuid/inbox',
    `/x/s/${STORE}`,
    `/s/${STORE}x`
  ])('finds no store in %s', path => expect(storeIdOfPath(path)).toBeNull())
})

describe('parseFrameOrigins', () => {
  it('keeps well-formed https origins', () => {
    expect(
      parseFrameOrigins('https://widgets.acme.example https://panel.other.example:8443', PLATFORM)
    ).toEqual(['https://widgets.acme.example', 'https://panel.other.example:8443'])
  })

  it.each([
    ['plain http', 'http://widgets.acme.example'],
    ['a path', 'https://widgets.acme.example/panel'],
    ['a trailing slash', 'https://widgets.acme.example/'],
    ['credentials', 'https://user:pw@widgets.acme.example'],
    ['a wildcard', 'https://*.acme.example'],
    ['a scheme that is not a web one', 'javascript:alert(1)'],
    [
      'a directive injected with a semicolon',
      "https://widgets.acme.example;script-src 'unsafe-inline'"
    ],
    ['text', 'not a url'],
    ['a different spelling of the origin', 'HTTPS://Widgets.Acme.Example']
  ])('drops %s', (_label, value) => {
    expect(parseFrameOrigins(value, PLATFORM)).toEqual([])
  })

  it('drops the platform and every host of its parent domain, a port or a dot included', () => {
    expect(
      parseFrameOrigins(
        [
          'https://app.example.com',
          'https://api.example.com',
          'https://plugins.example.com',
          'https://example.com:8443',
          'https://widgets.acme.example'
        ].join(' '),
        PLATFORM
      )
    ).toEqual(['https://widgets.acme.example'])
  })

  it('repeats nothing and holds at most twenty', () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://w${i}.acme${i}.example`)
    expect(parseFrameOrigins([...many, ...many].join(' '), PLATFORM)).toHaveLength(20)
    expect(parseFrameOrigins('https://a.acme.example https://a.acme.example', PLATFORM)).toEqual([
      'https://a.acme.example'
    ])
  })

  it('reads nothing from no cookie', () => {
    expect(parseFrameOrigins(undefined, PLATFORM)).toEqual([])
    expect(parseFrameOrigins('', PLATFORM)).toEqual([])
  })
})

describe('the cookie', () => {
  it('is named for the store', () => {
    expect(frameCookieName(STORE.toUpperCase())).toBe(`platform_widget_frames_${STORE}`)
  })

  it('round-trips through the encoding of a cookie value', () => {
    const origins = ['https://widgets.acme.example', 'https://panel.other.example']
    const raw = encodeURIComponent(serializeFrameOrigins(origins))
    expect(parseFrameOrigins(decodeCookieValue(raw), PLATFORM)).toEqual(origins)
  })

  it('reads a value that does not decode as no origins, not as an error', () => {
    expect(decodeCookieValue('%E0%A4%A')).toBe('')
  })
})

describe('the two checks of an origin agree', () => {
  // The parser of the cookie and the last check before the header are two patterns; a value one keeps must not be
  // dropped by the other, or a widget would be allowed in the cookie and blocked in the policy
  it.each([
    'https://widgets.acme.example',
    'https://panel.other.example:8443',
    'https://a1.b-c.example',
    'https://*.acme.example',
    'https://a.example;script-src',
    'http://plain.example',
    'https://UPPER.example'
  ])('keeps or drops %s in both', value => {
    const parsed = parseFrameOrigins(value, PLATFORM)
    const policy = buildContentSecurityPolicy({
      nonce: 'n',
      apiUrl: 'https://api.example.com',
      wsUrl: 'https://api.example.com',
      storageUrl: 'https://files.example.com',
      isDev: false,
      frameOrigins: [value]
    })
    const inPolicy = policy.includes(`frame-src ${value}`)
    expect(inPolicy).toBe(parsed.length === 1)
  })
})
