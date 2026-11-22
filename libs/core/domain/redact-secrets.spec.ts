import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isSecretName, redactSecrets, scrubSecretText } from './redact-secrets'
import { LOGGABLE_NAMES_THAT_LOOK_SECRET } from './redaction-constants'
import { REDACTED } from './scrub-url'

const asText = (value: unknown): string => JSON.stringify(value)

describe('isSecretName', () => {
  // Every spelling of every name the brief lists: camel, snake, kebab, upper and with a prefix
  it.each([
    'password',
    'Password',
    'userPassword',
    'secret',
    'client_secret',
    'x-client-secret',
    'token',
    'accessToken',
    'access_token',
    'refresh-token',
    'REFRESH_TOKEN',
    'idToken',
    'apiKey',
    'api_key',
    'api-key',
    'x-api-key',
    'authorization',
    'Authorization',
    'proxy-authorization',
    'cookie',
    'Set-Cookie',
    'set_cookie',
    'signature',
    'svix-signature',
    'x-hub-signature-256',
    'credential',
    'credentials',
    'privateKey',
    'private_key',
    'private-key',
    'idempotency_key',
    'signing-key',
    'credentialsEncrypted',
    'dataEncrypted',
    'sessionId',
    'jwt',
    'otp',
    'webhookSecret',
    'taxId'
  ])('takes %s for a secret', name => {
    expect(isSecretName(name)).toBe(true)
  })

  it.each([
    'storeId',
    'status',
    'state',
    'code',
    'key',
    'cacheKey',
    'objectKey',
    'name',
    'design',
    'author',
    'authorName',
    'correlationId',
    'attempt',
    'tokenCount',
    'tokensUsed',
    'max_tokens',
    'prompt-tokens'
  ])('does not take %s for a secret', name => {
    expect(isSecretName(name)).toBe(false)
  })

  it('has a reason for every name of the closed list of exceptions, and each is a normalized name', () => {
    for (const [name, reason] of Object.entries(LOGGABLE_NAMES_THAT_LOOK_SECRET)) {
      expect(name).toMatch(/^[a-z0-9]+$/)
      expect(reason.length).toBeGreaterThan(10)
    }
  })
})

// Every text pattern against strings of the maximum size built to make a backtracking regex work hard (9b, #891)
describe('scrubSecretText, hostile strings', () => {
  const HOSTILE: [string, string][] = [
    ['dotted scheme', 'a.'.repeat(32768)],
    ['hyphen scheme', 'a-'.repeat(32768)],
    ['plus scheme', 'a+'.repeat(32768)],
    ['long scheme', 'ab.'.repeat(21845)],
    ['token name', 'token.'.repeat(10923)],
    ['jwt starts', 'eyJ'.repeat(21845)],
    ['jwt run', `eyJ${'a'.repeat(65000)}`],
    ['bearer words', 'Bearer a '.repeat(7281)],
    ['bearer run', `Bearer ${'a'.repeat(65000)}`],
    ['basic run', `Basic ${'a'.repeat(65000)}`],
    ['quotes', '"a'.repeat(32768)],
    ['quoted names', '"token'.repeat(10923)],
    ['equals', 'a='.repeat(32768)],
    ['name equals', 'secret='.repeat(9362)],
    ['url params', '?code='.repeat(10923)],
    ['header lines', 'x-token:\n'.repeat(7281)],
    ['blank lines', '\n'.repeat(65000)],
    ['hyphen names', 'x-'.repeat(32768)]
  ]

  it.each(HOSTILE)('stays fast on %s', (_label, text) => {
    const started = performance.now()
    scrubSecretText(text)
    expect(performance.now() - started).toBeLessThan(150)
  })
})

describe('redactSecrets, the text of a line is bounded as a whole', () => {
  it('replaces the strings past the budget of the line, and never logs them unchecked', () => {
    const big = 'x'.repeat(60000)
    const out = redactSecrets({ list: Array.from({ length: 12 }, () => big) }) as { list: string[] }
    expect(out.list.at(-1)).toBe('[truncated]')
    expect(out.list[0]).toBe(big)
  })
})

describe('redactSecrets, the message of a log call and the lines it keeps', () => {
  it('redacts a lower case bearer and its token in a header=value text', () => {
    expect(scrubSecretText('authorization=bearer abcdefghijkl1234')).not.toContain('abcdefghijkl')
    expect(scrubSecretText('authorization: bearer abcdefghijkl1234')).not.toContain('abcdefghijkl')
  })

  it.each([
    'x-amz-security-token',
    'X-Auth-Token',
    'x-csrf-token',
    'x-goog-signature',
    'x-api-key',
    'set-cookie',
    'Cookie',
    'proxy-authorization'
  ])('redacts the line of the header %s', name => {
    expect(scrubSecretText(`${name}: real-value\nhost: a`)).toBe(`${name}: ${REDACTED}\nhost: a`)
  })

  it('does not take an error class for a header', () => {
    expect(scrubSecretText('InvalidTokenError: jwt expired')).toBe('InvalidTokenError: jwt expired')
  })

  it('redacts sessionKey as a field name', () => {
    expect(JSON.stringify(redactSecrets({ sessionKey: 'real-1' }))).not.toContain('real-1')
  })

  it('redacts code, state, sig and key params in an address or a text, and keeps the others', () => {
    const out = scrubSecretText(
      'GET /cb?code=real-1&state=real-2&sig=real-3&x=1&key=real-4 and ?page=2'
    )
    for (let n = 1; n <= 4; n += 1) expect(out).not.toContain(`real-${n}`)
    expect(out).toContain('x=1')
    expect(out).toContain('page=2')
  })

  it('does not redact code and state as fields', () => {
    expect(redactSecrets({ code: 'ECONNREFUSED', state: 'open' })).toEqual({
      code: 'ECONNREFUSED',
      state: 'open'
    })
  })

  it('keeps the other fields when one value throws', () => {
    const out = redactSecrets({
      a: {
        toJSON: () => {
          throw new Error('x')
        }
      },
      b: 'kept'
    }) as Record<string, unknown>
    expect(out['b']).toBe('kept')
    expect(out['a']).toBe('[truncated]')
  })
})

describe('redactSecrets, hostile input', () => {
  it('stays fast on a long string that is almost a pair, and cuts it', () => {
    const started = performance.now()
    const out = redactSecrets({ text: 'a.'.repeat(200000) }) as { text: string }
    expect(performance.now() - started).toBeLessThan(2000)
    expect(out.text.endsWith('[truncated]')).toBe(true)
  })

  it('does not raise on a getter that throws, and does not walk a socket or a request', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter')
      }
    }
    expect(() => redactSecrets({ hostile })).not.toThrow()
    expect(redactSecrets({ request: new EventEmitter() })).toEqual({ request: '[handle]' })
  })

  it('redacts a password in a connection address and a JWT, and leaves prose alone', () => {
    const text = 'connect redis://:real-pw@cache:6379 failed; eyJhbGciOiJI.eyJzdWIiOiIx.abcd1234'
    const out = scrubSecretText(text)
    expect(out).not.toContain('real-pw')
    expect(out).not.toContain('eyJhbGci')
    expect(scrubSecretText('Basic information is missing')).toBe('Basic information is missing')
  })

  it('redacts a list under the name tokens', () => {
    expect(JSON.stringify(redactSecrets({ tokens: ['real-1'] }))).not.toContain('real-1')
  })
})

describe('redactSecrets', () => {
  it('redacts the nested headers, body and query of a request, and keeps the rest', () => {
    const out = redactSecrets({
      req: {
        method: 'POST',
        headers: {
          Authorization: 'Bearer real-1',
          Cookie: 'sid=real-2',
          'X-Api-Key': 'real-3',
          'x-hub-signature-256': 'sha256=real-4',
          accept: 'json'
        },
        query: { access_token: 'real-5', page: '2' },
        body: { user: { password: 'real-6', name: 'ana' }, items: [{ refreshToken: 'real-7' }] }
      },
      res: { headers: { 'Set-Cookie': ['a=real-8'] } }
    })
    const text = asText(out)
    for (let n = 1; n <= 8; n += 1) expect(text).not.toContain(`real-${n}`)
    for (const kept of ['POST', 'json', '"page":"2"', 'ana']) expect(text).toContain(kept)
  })

  it('redacts the config of an axios-style error, its response and its raw request text', () => {
    const error = Object.assign(new Error('Request failed with status code 401'), {
      isAxiosError: true,
      config: {
        url: 'https://api.example.com/v1/x',
        headers: { Authorization: 'Bearer real-1', 'Content-Type': 'json' },
        data: '{"clientSecret":"real-2"}'
      },
      request: { _header: 'GET /x HTTP/1.1\r\nAuthorization: Bearer real-3\r\nHost: a\r\n\r\n' },
      response: { status: 401, config: { headers: { 'x-api-key': 'real-4' } } }
    })
    const out = redactSecrets({ failure: error }) as { failure: Record<string, unknown> }
    const text = asText(out)
    for (let n = 1; n <= 4; n += 1) expect(text).not.toContain(`real-${n}`)
    // The error is still an error in the log: its message and its status survive
    expect(out.failure['message']).toBe('Request failed with status code 401')
    expect(text).toContain('"status":401')
  })

  it('redacts the headers of a fetch Headers object', () => {
    const headers = new Headers({ authorization: 'Bearer real-1', accept: 'json' })
    const text = asText(redactSecrets({ headers }))
    expect(text).not.toContain('real-1')
    expect(text).toContain('json')
  })

  it('redacts the metadata of a job, a Map and a Set at any depth', () => {
    const out = redactSecrets({
      job: {
        id: '7',
        data: { storeId: 's1', connection: { deep: { deeper: { clientSecret: 'real-1' } } } }
      },
      map: new Map([['apiKey', 'real-2']]),
      set: new Set([{ token: 'real-3' }])
    })
    const text = asText(out)
    for (let n = 1; n <= 3; n += 1) expect(text).not.toContain(`real-${n}`)
    expect(text).toContain('s1')
  })

  it('keeps legitimate counters whose names look like a secret, and still walks into them', () => {
    const out = redactSecrets({
      ai: { tokenCount: 12, tokensUsed: 30, usage: { apiKey: 'real-1', total: 4 } }
    })
    const text = asText(out)
    expect(text).toContain('"tokenCount":12')
    expect(text).toContain('"tokensUsed":30')
    expect(text).toContain('"total":4')
    expect(text).not.toContain('real-1')
  })

  it('replaces the value of a secret with the marker, whatever its type', () => {
    expect(redactSecrets({ secret: { a: 1 }, token: 5, password: null })).toEqual({
      secret: REDACTED,
      token: REDACTED,
      password: REDACTED
    })
  })

  it('redacts the names a plugin declared', () => {
    const out = redactSecrets({ ctx: { acmeBadge: 'real-1', visible: 'x' } }, ['acmeBadge'])
    expect(asText(out)).not.toContain('real-1')
    expect(asText(out)).toContain('"visible":"x"')
  })

  it('redacts a bearer value inside a message', () => {
    expect(redactSecrets({ message: 'call failed with Bearer abcdef1234567890xyz here' })).toEqual({
      message: `call failed with Bearer ${REDACTED} here`
    })
    expect(scrubSecretText('grant=x&client_secret=abc123&page=2')).toBe(
      `grant=x&client_secret=${REDACTED}&page=2`
    )
    expect(scrubSecretText('{"api-key": "abc", "n": "ok"}')).toBe(
      `{"api-key": "${REDACTED}", "n": "ok"}`
    )
    expect(scrubSecretText('Cookie: sid=abc; other=1')).toBe(`Cookie: ${REDACTED}`)
  })

  it('does not change its input, and cuts a cycle and a deep payload', () => {
    const input: Record<string, unknown> = { token: 'real-1', nested: { ok: 1 } }
    input['self'] = input
    const out = redactSecrets(input) as Record<string, unknown>
    expect(input['token']).toBe('real-1')
    expect(out['self']).toBe('[circular]')
    let deep: Record<string, unknown> = { leaf: 'real-2', token: 'real-3' }
    for (let level = 0; level < 40; level += 1) deep = { next: deep }
    const text = asText(redactSecrets(deep))
    expect(text).not.toContain('real-3')
    expect(text).toContain('[truncated]')
  })

  it('keeps a field named __proto__ as a field and does not touch the prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as unknown
    const out = redactSecrets(input) as Record<string, unknown>
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(out['ok']).toBe(1)
  })

  it('passes dates, numbers and null through', () => {
    const when = new Date(0)
    expect(redactSecrets({ when, n: 1, none: null })).toEqual({ when, n: 1, none: null })
  })
})

// A field added to the database with a secret-like name must not reach a log by accident: this fails until its
// author either renames it or lists it below with the reason it is safe to log. The check is on the Prisma
// schema because every logged context ends up carrying a record of it sooner or later.
describe('the fields of the database', () => {
  // Names that look like a secret to the pattern below and are not. Closed: a new name is added with a reason.
  const SAFE_TO_LOG: Readonly<Record<string, string>> = {
    clientKey: 'the screen-chosen idempotency key of a retry, not a credential',
    closingHash: 'sha256 of a closed accounting month: an integrity value, public to the auditor',
    correlativeScopeKey: 'the series a fiscal number belongs to',
    eventKey: 'what the producer says identifies an event, for deduplication',
    hasHeader: 'a flag of a bank statement import',
    hash: 'sha256 of a ledger entry: an integrity value, not a key to anything',
    iconKey: 'the storage key of an icon, public',
    idempotencyKey: 'a replay key chosen by the caller, not a credential',
    ipHash: 'a salted hash of an address used to count, not reversible',
    keyPrefix: 'the first characters of an api key, shown in the settings to tell keys apart',
    key: 'the storage key of an object',
    lastEntryHash: 'sha256 of the last ledger entry',
    lineHash: 'sha256 of a ledger line',
    messageKey: 'an i18n key',
    prevHash: 'sha256 of the previous ledger entry',
    resultKey: 'the storage key of an export result',
    scopeKey: 'the scope of a counter',
    sessions: 'the relation list of a user, not a value',
    voidClaimKey: 'an idempotency key of a void claim'
  }

  const SCHEMA = join(__dirname, '../database/prisma/schema.prisma')
  const LOOKS_LIKE_A_SECRET =
    /secret|token|password|key|hash|signature|cipher|encrypt|credential|cookie|otp|salt|nonce|auth(?!or)|session|jwt|sid$|pin$|certificate/i

  function schemaFields(): string[] {
    const names = new Set<string>()
    for (const line of readFileSync(SCHEMA, 'utf8').split('\n')) {
      const match = /^ {2}([a-zA-Z_]\w*)\s+[A-Z]\w*[?[\]]*/.exec(line)
      if (match?.[1] !== undefined && !line.trim().startsWith('@@')) names.add(match[1])
    }
    return [...names]
  }

  const suspects = schemaFields().filter(name => LOOKS_LIKE_A_SECRET.test(name))

  it('reads the schema', () => {
    expect(schemaFields().length).toBeGreaterThan(500)
    expect(suspects.length).toBeGreaterThan(20)
  })

  it('redacts every secret-looking field, unless it is listed as safe to log with a reason', () => {
    const unhandled = suspects.filter(name => !isSecretName(name) && !(name in SAFE_TO_LOG))
    expect(unhandled).toEqual([])
  })

  it('keeps the safe list closed: every name in it still exists and still looks like a secret', () => {
    const present = new Set(suspects)
    const stale = Object.keys(SAFE_TO_LOG).filter(name => !present.has(name))
    expect(stale).toEqual([])
    for (const reason of Object.values(SAFE_TO_LOG)) expect(reason.length).toBeGreaterThan(10)
  })

  it('does not list as safe a name the redactor already redacts', () => {
    expect(Object.keys(SAFE_TO_LOG).filter(name => isSecretName(name))).toEqual([])
  })
})
