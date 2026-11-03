import { providerErrorText, providerText } from './provider-text'

const R = '[redacted]'
// Built here, so that no line of the file reads as a committed secret
const CREDENTIAL = ['a1b2c3d4', 'e5f6g7h8i9'].join('')
const ZWSP = String.fromCharCode(0x200b)
const BACKSLASH = String.fromCharCode(92)

describe('providerErrorText', () => {
  it('replaces a bearer credential', () => {
    expect(providerErrorText('401 with Bearer abc.DEF-123_xyz rejected', 100)).toBe(
      `401 with Bearer ${R} rejected`
    )
  })

  it('replaces a named value after = and in query strings', () => {
    expect(providerErrorText('GET /me?access_token=EAAB123&fields=id failed', 100)).toBe(
      `GET /me?access_token=${R}&fields=id failed`
    )
    expect(providerErrorText('secret=abc', 100)).toBe(`secret=${R}`)
    expect(providerErrorText('fb_access_token=abc', 100)).toBe(`fb_access_token=${R}`)
  })

  it('replaces a short value of a name that is always a credential, after a colon too', () => {
    expect(providerErrorText('password: hunter2', 100)).toBe(`password: ${R}`)
    expect(providerErrorText('api_key: abc123def', 100)).toBe(`api_key: ${R}`)
    expect(providerErrorText('x-api-key: 9f8e7d6c', 100)).toBe(`x-api-key: ${R}`)
    expect(providerErrorText('client_secret: s3cr3t', 100)).toBe(`client_secret: ${R}`)
  })

  it('replaces the whole Authorization value, whatever the scheme', () => {
    expect(providerErrorText('Authorization: Bearer abc123', 100)).toBe(`Authorization: ${R}`)
    expect(providerErrorText('Authorization: Basic dXNlcjpwYXNz', 100)).toBe(`Authorization: ${R}`)
    expect(providerErrorText('authorization=Token k3y', 100)).toBe(`authorization=${R}`)
  })

  it('replaces values in JSON text, quoted or not, and in a body quoted inside a string', () => {
    expect(providerErrorText('{"access_token":"x1","error":"bad"}', 100)).toBe(
      `{"access_token":${R},"error":"bad"}`
    )
    const escaped = `{"error":"{${BACKSLASH}"access_token${BACKSLASH}":${BACKSLASH}"abc123${BACKSLASH}"}"}`
    const result = providerErrorText(escaped, 200)
    expect(result).not.toContain('abc123')
    expect(result).toContain(R)
    expect(providerErrorText('access_token%3Dabc123', 100)).toBe(`access_token%3D${R}`)
  })

  it('replaces a quoted value that holds a space or an escaped quote', () => {
    expect(providerErrorText('secret="two words"', 100)).toBe(`secret=${R}`)
    expect(providerErrorText(`secret="ab${BACKSLASH}"cdef" end`, 100)).toBe(`secret=${R} end`)
  })

  it('replaces a value split by an invisible character, and a name split by one', () => {
    expect(providerErrorText(`access_token=abc${ZWSP}def`, 100)).toBe(`access_token=${R}`)
    expect(providerErrorText(`pass${ZWSP}word=abc`, 100)).toBe(`password=${R}`)
  })

  it('keeps a bare token or secret followed by prose, and replaces one followed by a credential', () => {
    expect(providerErrorText('Invalid token: expired', 100)).toBe('Invalid token: expired')
    expect(providerErrorText('Invalid token: permission_denied_for_this_app', 100)).toBe(
      'Invalid token: permission_denied_for_this_app'
    )
    expect(providerErrorText('Invalid token: "expired"', 100)).toBe('Invalid token: "expired"')
    expect(providerErrorText(`token: ${CREDENTIAL}`, 100)).toBe(`token: ${R}`)
    expect(providerErrorText(`"secret":"${CREDENTIAL}"`, 100)).toBe(`"secret":${R}`)
  })

  it('replaces a JWT and a Meta token that stand alone', () => {
    expect(providerErrorText('got eyJhbGciOi.eyJzdWIiOiIx.sig back', 100)).toBe(`got ${R} back`)
    expect(providerErrorText(`bad EAAGm0PX4ZCpsBA${'Z'.repeat(20)} here`, 100)).toBe(
      `bad ${R} here`
    )
  })

  it('redacts before cutting, so a cut never leaves the start of a secret', () => {
    expect(providerErrorText('Bearer abc123defghijklmnop', 10)).toBe('Bearer [re')
  })

  it('stops a value at a closing bracket', () => {
    expect(providerErrorText('failed (password: hunter2) {"api_key":abc}', 100)).toBe(
      `failed (password: ${R}) {"api_key":${R}}`
    )
  })

  it('is idempotent', () => {
    const text =
      'Authorization: Basic dXNlcjpwYXNz token=abc password: x Bearer zzz access_token="q" eyJhbGciOi.eyJzdWIiOiIx.sig'
    const once = providerErrorText(text, 300)
    expect(providerErrorText(once, 300)).toBe(once)
  })

  it('answers a very long message without working on all of it', () => {
    // A quadratic match or a copy of the whole string would take minutes here; the bound is loose on purpose
    for (const text of ['a'.repeat(3_000_000), 'token'.repeat(600_000), '='.repeat(3_000_000)]) {
      const started = Date.now()
      providerErrorText(text, 300)
      expect(Date.now() - started).toBeLessThan(5000)
    }
  })

  it('replaces more names of credentials', () => {
    for (const name of ['secret_key', 'AWS_SECRET_ACCESS_KEY', 'private_key', 'session_token']) {
      expect(providerErrorText(`${name}=abc`, 100)).toBe(`${name}=${R}`)
    }
  })

  it('replaces a value with an unterminated quote or with symbols in it', () => {
    expect(providerErrorText('password="abc def', 100)).toBe(`password=${R}`)
    expect(providerErrorText('access_token:"abc', 100)).toBe(`access_token:${R}`)
    expect(providerErrorText('password=ab"cd', 100)).toBe(`password=${R}`)
    expect(providerErrorText('password=ab;cd', 100)).toBe(`password=${R}`)
  })

  it('replaces a header with several parts and the password of an address', () => {
    expect(
      providerErrorText('Authorization: AWS4-HMAC-SHA256 Credential=AKIA/x, Signature=abc123', 200)
    ).toBe(`Authorization: ${R}`)
    expect(providerErrorText('GET https://bob:s3cret@host/x failed', 100)).toBe(
      `GET https://bob:${R}@host/x failed`
    )
  })

  it('replaces an Authorization header written as JSON, with or without a space after the colon', () => {
    const basic = providerErrorText('{"Authorization":"Basic dXNlcjpwYXNz"}', 100)
    expect(basic).not.toContain('dXNlcjpwYXNz')
    const digest = providerErrorText('{"Authorization": "Digest user=a, response=zz"}', 100)
    expect(digest).not.toContain('response=zz')
    expect(digest).not.toContain('user=a')
  })

  it('replaces the whole of a quoted value when the other kind of quote follows', () => {
    expect(providerErrorText(`password="abc def' ghi`, 100)).toBe(`password=${R}`)
  })

  it('replaces the password of an address even when it holds an @', () => {
    expect(providerErrorText('https://bob:p@ss@host/x', 100)).toBe(`https://bob:${R}@host/x`)
  })

  it('replaces an escaped quoted value that holds a space', () => {
    const body = `{"error":"{${BACKSLASH}"access_token${BACKSLASH}":${BACKSLASH}"abc 123${BACKSLASH}"}"}`
    const result = providerErrorText(body, 200)
    expect(result).not.toContain('abc')
    expect(result).not.toContain('123')
  })

  it('replaces a name split by a variation selector or a filler', () => {
    for (const hidden of [0xfe0f, 0x3164, 0x2800, 0x115f]) {
      expect(providerErrorText(`pass${String.fromCharCode(hidden)}word=abc`, 100)).toBe(
        `password=${R}`
      )
    }
  })

  it('replaces a value after a url-encoded colon and after a cookie name', () => {
    expect(providerErrorText(`token%3A${CREDENTIAL}`, 100)).toBe(`token%3A${R}`)
    expect(providerErrorText('Cookie: sessionid=abc123def', 100)).toBe(`Cookie: ${R}`)
  })

  it('replaces a name split by a joiner or a soft hyphen', () => {
    for (const hidden of [0x200d, 0x200c, 0xad]) {
      expect(providerErrorText(`pass${String.fromCharCode(hidden)}word=abc`, 100)).toBe(
        `password=${R}`
      )
    }
  })

  it('keeps the word bearer in prose', () => {
    expect(providerErrorText('Missing bearer token in header', 100)).toBe(
      'Missing bearer token in header'
    )
  })

  it('leaves ordinary messages alone', () => {
    for (const text of [
      'The rate limit was hit, try again',
      'Tokens Café',
      'Mi tienda: ropa y más',
      'Bearer'
    ]) {
      expect(providerErrorText(text, 100)).toBe(text)
    }
  })
})

describe('providerText does not redact', () => {
  it('keeps a name that looks like a credential, because a name is not an error', () => {
    for (const name of ['reset_token=v2', 'Secret=Garden', 'Bearer token missing']) {
      expect(providerText(name, 100)).toBe(name)
    }
  })
})
