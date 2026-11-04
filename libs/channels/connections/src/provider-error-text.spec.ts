import { providerErrorText, providerText } from './provider-text'

const R = '[redacted]'
// Built here, so that no line of the file reads as a committed secret
const CREDENTIAL = ['a1b2c3d4', 'e5f6g7h8i9'].join('')
const ZWSP = String.fromCharCode(0x200b)
const BACKSLASH = String.fromCharCode(92)
// Shapes of real keys, built from parts so that no line of this file reads as a committed secret
const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const STRIPE_KEY = ['sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'].join('')
const SLACK_TOKEN = ['xox', 'b-123456789012-1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('')
const GITHUB_TOKEN = ['gh', 'p_16C7e42F292c6912E7710c838347Ae178B4a'].join('')
const GOOGLE_KEY = ['AI', 'zaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe'].join('')
const PEM_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const PEM_END = ['-----END ', 'PRIVATE KEY-----'].join('')
const VERIFY_VALUE = ['mySecret', 'Verify123'].join('')
const INSTAGRAM_TOKEN = ['IG', 'QVJYabcdefghijklmnopqrstuvwxyz0123456789'].join('')

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

// SEC-8: the QA threw 17 shapes of a leaked credential at the redactor and 3 were replaced. These are the
// shapes a provider (or a library that wraps its answer) repeats back: a signature, a scheme word, a key
// that carries the name of its issuer, a pasted private key, a name inside an address.
describe('providerErrorText, the shapes of a leaked credential', () => {
  const LEAKED_FORMS: readonly (readonly [string, string, string])[] = [
    ['basic bare', 'rejected Basic dXNlcjpwYXNzd29yZA== by host', 'dXNlcjpwYXNzd29yZA'],
    [
      'hub signature header',
      'X-Hub-Signature-256: sha256=9f86d081884c7d659a2feaa0c55ad015',
      '9f86d081884c7d659a2f'
    ],
    [
      'svix signature',
      'svix-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=',
      'K5oZfzN95Z9UVu1'
    ],
    ['signature query', 'GET /x?X-Amz-Signature=abcdef0123456789abcdef&a=1', 'abcdef0123456789'],
    ['auth-token short', 'X-Auth-Token: abc123', 'abc123'],
    ['aws key id', `bad key ${AWS_KEY} for user`, AWS_KEY],
    ['stripe key', `invalid key ${STRIPE_KEY}`, STRIPE_KEY],
    ['slack token', `invalid_auth ${SLACK_TOKEN}`, SLACK_TOKEN],
    ['github token', `bad credentials ${GITHUB_TOKEN}`, GITHUB_TOKEN],
    ['google key', `key ${GOOGLE_KEY} invalid`, GOOGLE_KEY],
    ['instagram token', `token ${INSTAGRAM_TOKEN} expired`, INSTAGRAM_TOKEN],
    [
      'pem',
      `${PEM_BEGIN}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${PEM_END}`,
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
    ],
    [
      'apikey scheme',
      'sent ApiKey 7f3a9c1e5b2d4f6a8c0e1b3d5f7a9c2e to host',
      '7f3a9c1e5b2d4f6a8c0e1b3d5f7a9c2e'
    ],
    ['oauth header', 'OAuth oauth_token="abc123xyz", oauth_signature="s1gn4tur3"', 's1gn4tur3'],
    [
      'sas sig',
      'https://acct.blob.core.windows.net/c?sv=2020&sig=Zm9vYmFyYmF6cXV4&se=2030',
      'Zm9vYmFyYmF6cXV4'
    ],
    [
      'long hex',
      'secret was 0123456789abcdef0123456789abcdef01234567 apparently',
      '0123456789abcdef0123456789abcdef01234567'
    ],
    [
      'json client secret camel',
      '{"clientSecret":"s3cr3tValue","appSecret":"x9y8z7"}',
      's3cr3tValue'
    ],
    ['camel accessToken', '{"accessToken":"ab12cd34","refreshToken":"zz99yy88"}', 'ab12cd34'],
    ['userinfo no password', 'GET https://abc123def456ghi789@host/x', 'abc123def456ghi789'],
    [
      'token in path',
      `POST https://hooks.slack.com/services/T000/B000/${'X'.repeat(24)} failed`,
      'X'.repeat(24)
    ],
    ['whatsapp verify', `hub.verify_token=${VERIFY_VALUE}`, VERIFY_VALUE],
    ['x-api-key json', '{"x-api-key":"k1k2k3"}', 'k1k2k3'],
    ['proxy auth', 'Proxy-Authorization: Basic Zm9vOmJhcg==', 'Zm9vOmJhcg'],
    ['password colon json', '{"password":"hunter2"}', 'hunter2']
  ]

  it.each(LEAKED_FORMS)('replaces %s', (_name, text, secret) => {
    const result = providerErrorText(text, 400)
    expect(result).not.toContain(secret)
    expect(result).toContain(R)
  })

  it('replaces a short base64 credential made of letters only, after Basic or Bearer', () => {
    expect(providerErrorText('rejected Basic dXNlcjpwYXNz by host', 100)).toBe(
      `rejected Basic ${R} by host`
    )
    expect(providerErrorText('Bearer dXNlcjpwYXNz', 100)).toBe(`Bearer ${R}`)
  })

  it('keeps the words of a message that only mention them', () => {
    for (const text of [
      'Basic plan limit reached',
      'Token expired',
      'Invalid token abc-def',
      'Digest of the day is empty',
      'Invalid signature algorithm',
      'The design was refused',
      'Commit 9f86d08 failed',
      'Request id 4b3403665fea6a8a'
    ]) {
      expect(providerErrorText(text, 100)).toBe(text)
    }
  })

  it('stays idempotent and fast on a long run of what it looks for', () => {
    const text = `${'-----BEGIN PRIVATE KEY-----'.repeat(2000)} ${'a'.repeat(100_000)} ${'sig='.repeat(20_000)}`
    const once = providerErrorText(text, 300)
    expect(providerErrorText(once, 300)).toBe(once)
    const started = Date.now()
    providerErrorText(text, 300)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('providerText does not redact', () => {
  it('keeps a name that looks like a credential, because a name is not an error', () => {
    for (const name of ['reset_token=v2', 'Secret=Garden', 'Bearer token missing']) {
      expect(providerText(name, 100)).toBe(name)
    }
  })
})
