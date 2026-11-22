import type { IncomingMessage, ServerResponse } from 'node:http'
import { Writable } from 'node:stream'

import { pino } from 'pino'

import { InfraRoutes } from '@platform/core/api'
import { REDACTED, SENSITIVE_QUERY_PARAMS } from '@platform/core/domain'

import type { AuthenticatedRequest } from './authenticated-request'
import {
  buildPinoHttpOptions,
  logLevelFor,
  redactedPathsFor,
  REDACTED_PATHS,
  REDACTED_SECRET_KEYS,
  scrubRequest
} from './logger-options'

describe('logLevelFor', () => {
  it('maps the status of a response to a level', () => {
    expect(logLevelFor(200, undefined)).toBe('info')
    expect(logLevelFor(302, undefined)).toBe('info')
    expect(logLevelFor(404, undefined)).toBe('warn')
    expect(logLevelFor(500, undefined)).toBe('error')
    expect(logLevelFor(200, new Error('boom'))).toBe('error')
  })
})

describe('buildPinoHttpOptions', () => {
  const options = buildPinoHttpOptions({ level: 'debug' })

  it('never asks for a transport, which a bundle cannot start', () => {
    expect(options.transport).toBeUndefined()
  })

  it('keeps probes and scrapes out of the log, query string included', () => {
    const ignore = options.autoLogging as { ignore: (req: IncomingMessage) => boolean }
    for (const path of [InfraRoutes.healthLive, InfraRoutes.healthReady, InfraRoutes.metrics]) {
      expect(ignore.ignore({ url: path } as IncomingMessage)).toBe(true)
    }
    expect(ignore.ignore({ url: `${InfraRoutes.metrics}?format=text` } as IncomingMessage)).toBe(
      true
    )
    expect(ignore.ignore({ url: '/api/v1/conversations' } as IncomingMessage)).toBe(false)
  })

  it('puts the request context on every line', () => {
    const request = {
      correlationId: 'c-1',
      user: { id: 'u-1' },
      store: { id: 's-1' },
      organization: { id: 'o-1' }
    } as AuthenticatedRequest
    const customProps = options.customProps as (req: IncomingMessage, res: ServerResponse) => object
    expect(customProps(request, {} as ServerResponse)).toEqual({
      correlationId: 'c-1',
      userId: 'u-1',
      storeId: 's-1',
      organizationId: 'o-1'
    })
  })
})

describe('redaction', () => {
  it('lists the generic spellings of an app secret, and no provider by name', () => {
    expect(REDACTED_SECRET_KEYS).toContain('appSecret')
    expect(REDACTED_SECRET_KEYS).toContain('app_secret')
    // The customer data of a fiscal document and the certificate of the issuer
    for (const key of [
      'taxId',
      'tax_id',
      'registrationId',
      'registration_id',
      'taxpayerType',
      'taxpayer_type',
      'economicActivity',
      'economic_activity',
      'certificate'
    ]) {
      expect(REDACTED_SECRET_KEYS).toContain(key)
    }
    expect(
      REDACTED_SECRET_KEYS.filter(name => /instagram|meta|whatsapp|messenger/i.test(name))
    ).toEqual([])
  })

  it('removes the decrypted credentials of a connection, whatever their keys', () => {
    const output = logged({
      credentials: { token: 'secret-1' },
      ctx: { credentials: { token: 'secret-2', clientSecretX: 'secret-3' }, connectionId: 'kept' },
      result: { credentials: { session: 'secret-4' } }
    })
    for (const secret of ['secret-1', 'secret-2', 'secret-3', 'secret-4']) {
      expect(output).not.toContain(secret)
    }
    expect(output).toContain('kept')
  })

  it('removes credentials and authorization headers that sit deeper, as in a provider error', () => {
    const output = logged({
      connection: { ctx: { credentials: { token: 'deep-1' } } },
      err: {
        config: { headers: { Authorization: 'Bearer deep-2', authorization: 'Bearer deep-3' } }
      },
      error: { response: { config: { headers: { Authorization: 'Bearer deep-4' } } } }
    })
    for (const secret of ['deep-1', 'deep-2', 'deep-3', 'deep-4']) {
      expect(output).not.toContain(secret)
    }
  })

  // SEC-R1-04: a secret logged alone, or under a name a provider spells another way, or a few levels
  // down, left the log with its value. Run with the real pino, which is what decides.
  const SECRET_KEYS = REDACTED_SECRET_KEYS
  // The depth is the number of objects that wrap the key: 0 is the top level of what is logged
  const wrapped = (key: string, value: string, depth: number): Record<string, unknown> => {
    let payload: Record<string, unknown> = { [key]: value }
    for (let level = 0; level < depth; level += 1) payload = { [`layer${level}`]: payload }
    return payload
  }

  describe.each(SECRET_KEYS)('the secret %s', key => {
    it.each([0, 1, 2, 3, 4])('is removed at %i levels of depth', depth => {
      const output = logged({ ...wrapped(key, 'leak-value', depth), kept: 'still-here' })

      expect(output).not.toContain('leak-value')
      expect(output).toContain('still-here')
    })
  })

  it.each([0, 1, 2, 3, 4])(
    'removes the credentials of a connection at %i levels of depth',
    depth => {
      const output = logged(wrapped('credentials', 'leak-credentials', depth))

      expect(output).not.toContain('leak-credentials')
    }
  )

  it.each(['Authorization', 'authorization'])(
    'removes the %s header of a call up to 4 levels down',
    name => {
      const output = logged({
        a: { b: { c: { d: { headers: { [name]: 'Bearer leak-header' } } } } },
        e: { headers: { [name]: 'Bearer leak-header-2' } }
      })

      expect(output).not.toContain('leak-header')
    }
  )

  function logged(payload: object): string {
    let output = ''
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString()
        done()
      }
    })
    pino({ redact: { paths: [...REDACTED_PATHS], remove: true } }, stream).info(payload, 'request')
    return output
  }

  it('removes the address a redirect sends the browser to, which can carry the id of a login session', () => {
    const output = logged({
      res: {
        statusCode: 302,
        headers: { location: 'https://app.example.com/s/1/settings/channels?oauth=the-session-id' }
      }
    })
    expect(output).not.toContain('the-session-id')
    expect(output).toContain('302')
  })

  it('removes credentials and secrets from what is logged', () => {
    const output = logged({
      req: {
        headers: {
          authorization: 'Bearer abc',
          cookie: 'sid=1',
          'x-api-key': 'k',
          'proxy-authorization': 'Basic xyz',
          accept: 'json'
        },
        body: {
          password: 'p',
          token: 't',
          refreshToken: 'r',
          credentials: { accessToken: 'a' },
          name: 'ok'
        }
      },
      res: { headers: { 'set-cookie': 'sid=2' } },
      plugin: { apiKey: 'k2', secret: 's', accessToken: 'a2', refreshToken: 'r2', label: 'kept' }
    })
    for (const secret of [
      'Bearer abc',
      'sid=1',
      'sid=2',
      '"k"',
      '"p"',
      '"t"',
      '"r"',
      'k2',
      '"s"',
      'a2',
      'r2',
      'Basic xyz'
    ]) {
      expect(output).not.toContain(secret)
    }
    for (const kept of ['json', '"ok"', 'kept']) expect(output).toContain(kept)
  })
})

// SEC-7: the request log dumped `svix-signature`. A header that proves who sent a request or lets
// someone act as them is never logged, whatever its name: a provider we add later brings its own.
describe('scrubRequest, headers', () => {
  const secrets = {
    'svix-signature': 'v1,Zm9vYmFy',
    'x-signature': 'sig-1',
    'x-hub-signature': 'sha1=sig-2',
    'x-hub-signature-256': 'sha256=deadbeef',
    'x-twilio-signature': 'sig-3',
    'stripe-signature': 't=1,v1=sig-4',
    'x-webhook-signature': 'sig-5',
    Authorization: 'Bearer abc',
    'proxy-authorization': 'Basic xyz',
    cookie: 'sid=1',
    'set-cookie': 'sid=2',
    'x-api-key': 'key-1',
    'x-plugin-api-key': 'key-2',
    'x-auth-token': 'tok-1',
    'x-csrf-token': 'tok-2',
    'x-amz-security-token': 'tok-3',
    'x-client-secret': 'sec-1'
  }
  const kept = {
    'svix-id': 'msg_1',
    'svix-timestamp': '1700000000',
    'content-type': 'application/json',
    'x-store-id': 'store-1',
    'user-agent': 'curl'
  }

  it('redacts the value of every header that carries a signature or a credential', () => {
    const { headers } = scrubRequest({ headers: { ...secrets, ...kept } })
    for (const name of Object.keys(secrets)) {
      expect(headers).toHaveProperty([name], REDACTED)
    }
    expect(headers).toMatchObject(kept)
  })

  it('keeps the name of the header, so the log still shows that one was sent', () => {
    const { headers } = scrubRequest({ headers: { 'svix-signature': 'v1,abc' } })
    expect(Object.keys(headers as object)).toEqual(['svix-signature'])
  })

  it('leaves no secret in the line pino writes', () => {
    let output = ''
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString()
        done()
      }
    })
    pino(buildPinoHttpOptions({ level: 'info' }) as object, stream).info(
      { req: scrubRequest({ headers: { ...secrets, ...kept } }) },
      'request'
    )
    for (const value of Object.values(secrets)) expect(output).not.toContain(value)
    expect(output).toContain('msg_1')
  })
})

// The token of an invitation travels in the path (GET /invitations/:token) and is as good as a
// password until it is used or expires: the log must never hold it
describe('scrubRequest, query string', () => {
  const handshake = (secret: string): string =>
    `/api/v1/webhooks/channels/whatsapp?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${secret}`

  it('keeps the name of a sensitive param and drops its value, the rest stays readable', () => {
    expect(scrubRequest({ url: handshake('s3cret') }).url).toBe(
      `/api/v1/webhooks/channels/whatsapp?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${REDACTED}`
    )
  })

  it.each(SENSITIVE_QUERY_PARAMS)('redacts %s', name => {
    expect(scrubRequest({ url: `/api/v1/x?a=1&${name}=s3cret&b=2` }).url).toBe(
      `/api/v1/x?a=1&${name}=${REDACTED}&b=2`
    )
  })

  it('redacts every copy of a repeated param', () => {
    expect(scrubRequest({ url: '/api/v1/x?token=a&ok=1&token=b' }).url).toBe(
      `/api/v1/x?token=${REDACTED}&ok=1&token=${REDACTED}`
    )
  })

  it('reads an encoded name and ignores the case', () => {
    expect(
      scrubRequest({ url: '/api/v1/x?hub%2Everify_token=s3cret&ACCESS_TOKEN=s3cret' }).url
    ).toBe(`/api/v1/x?hub%2Everify_token=${REDACTED}&ACCESS_TOKEN=${REDACTED}`)
  })

  it('redacts an empty value and a name with no value as well as a full one', () => {
    expect(scrubRequest({ url: '/api/v1/x?token=&code' }).url).toBe(
      `/api/v1/x?token=${REDACTED}&code`
    )
  })

  it('leaves a url without a query, or with harmless params, as it is', () => {
    for (const url of [
      '/api/v1/x',
      '/api/v1/x?',
      '/api/v1/x?page=2&limit=10',
      '/api/v1/x?tokens=1'
    ]) {
      expect(scrubRequest({ url }).url).toBe(url)
    }
  })

  it('redacts a sensitive pair after a #, which a tolerant parser could still read as a param', () => {
    expect(scrubRequest({ url: '/api/v1/x?a=1#access_token=s3cret&top=1' }).url).toBe(
      `/api/v1/x?a=1#access_token=${REDACTED}&top=1`
    )
    expect(scrubRequest({ url: '/api/v1/x?token=s3cret#top' }).url).toBe(
      `/api/v1/x?token=${REDACTED}#top`
    )
    // The pairs of an OAuth redirect that comes back in the fragment
    expect(scrubRequest({ url: '/cb#code=a&state=b&scope=read' }).url).toBe(
      `/cb#code=${REDACTED}&state=${REDACTED}&scope=read`
    )
  })

  it('reads a name with brackets or dots by every part of it', () => {
    expect(
      scrubRequest({
        url: '/api/v1/x?token[]=a&token[0]=b&filter[token]=c&auth.access_token=d&ok[]=e'
      }).url
    ).toBe(
      `/api/v1/x?token[]=${REDACTED}&token[0]=${REDACTED}&filter[token]=${REDACTED}&auth.access_token=${REDACTED}&ok[]=e`
    )
    expect(scrubRequest({ url: '/api/v1/x?token%5B%5D=a&filter%5Btoken%5D=b' }).url).toBe(
      `/api/v1/x?token%5B%5D=${REDACTED}&filter%5Btoken%5D=${REDACTED}`
    )
  })

  it('redacts the names that end like a secret, so a new param fails closed', () => {
    const url =
      '/api/v1/x?refresh_token=a&refreshToken=b&client_secret=c&idempotency_key=d&Password=e&sig=f&page=2'
    expect(scrubRequest({ url }).url).toBe(
      `/api/v1/x?refresh_token=${REDACTED}&refreshToken=${REDACTED}&client_secret=${REDACTED}&idempotency_key=${REDACTED}&Password=${REDACTED}&sig=${REDACTED}&page=2`
    )
  })

  it('splits on ; as well, so a param cannot hide in the value of the one before', () => {
    expect(scrubRequest({ url: '/api/v1/x?a=1;token=s3cret&b=2' }).url).toBe(
      `/api/v1/x?a=1;token=${REDACTED}&b=2`
    )
  })

  it('redacts the token of an invitation when slashes repeat, which the router takes as one', () => {
    expect(scrubRequest({ url: '//api/v1/invitations/abc123' }).url).toBe(
      `//api/v1/invitations/${REDACTED}`
    )
    expect(scrubRequest({ url: '/api//v1///invitations//abc123/accept' }).url).toBe(
      `/api//v1///invitations//${REDACTED}/accept`
    )
  })

  it('redacts the token of an invitation when the target is an absolute url', () => {
    expect(scrubRequest({ url: 'http://host/api/v1/invitations/abc123?token=s3cret' }).url).toBe(
      `http://host/api/v1/invitations/${REDACTED}?token=${REDACTED}`
    )
  })

  it('does not break on a name that is not valid percent-encoding', () => {
    expect(scrubRequest({ url: '/api/v1/x?%E0%A4%A=1&token=s3cret' }).url).toBe(
      `/api/v1/x?%E0%A4%A=1&token=${REDACTED}`
    )
  })

  it('redacts the parsed query that pino logs next to the url', () => {
    const scrubbed = scrubRequest({
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 's3cret',
        Access_Token: ['a', 'b'],
        page: '2'
      }
    })

    expect(scrubbed.query).toEqual({
      'hub.mode': 'subscribe',
      'hub.verify_token': REDACTED,
      Access_Token: REDACTED,
      page: '2'
    })
  })

  it('walks a query that nests, whatever the parser', () => {
    const scrubbed = scrubRequest({
      query: {
        filter: { token: 's3cret', page: '2' },
        hub: { verify_token: 's3cret' },
        list: [{ code: 'x' }]
      }
    })

    expect(JSON.stringify(scrubbed)).not.toContain('s3cret')
    expect(scrubbed.query).toEqual({
      filter: { token: REDACTED, page: '2' },
      hub: { verify_token: REDACTED },
      list: [{ code: REDACTED }]
    })
  })

  it('does not break on a query that is not an object', () => {
    expect(scrubRequest({ query: null as unknown as undefined }).query).toBeNull()
    expect(scrubRequest({ query: 'x' as unknown as undefined }).query).toBe('x')
  })

  it('does not take an empty segment for a token', () => {
    expect(scrubRequest({ url: '/api/v1/invitations/?status=open' }).url).toBe(
      '/api/v1/invitations/?status=open'
    )
  })

  it('catches the names that are written together or that nobody listed', () => {
    const url =
      '/api/v1/x?secretKey=a&accessKey=b&authorization=c&jwt=d&sessionId=e&pwd=f&monkey=ok'
    expect(scrubRequest({ url }).url).toBe(
      `/api/v1/x?secretKey=${REDACTED}&accessKey=${REDACTED}&authorization=${REDACTED}&jwt=${REDACTED}&sessionId=${REDACTED}&pwd=${REDACTED}&monkey=ok`
    )
  })

  it('cleans the url of the page that called, which carries the same secrets', () => {
    const scrubbed = scrubRequest({
      headers: { Referer: 'https://app.example.com/cb?code=s3cret&page=2', host: 'api' }
    })

    expect(scrubbed.headers).toEqual({
      Referer: `https://app.example.com/cb?code=${REDACTED}&page=2`,
      host: 'api'
    })
  })

  it('works together with the invitation token of the path', () => {
    expect(scrubRequest({ url: '/api/v1/invitations/abc123?token=s3cret' }).url).toBe(
      `/api/v1/invitations/${REDACTED}?token=${REDACTED}`
    )
  })

  it('reaches the line that the serializer of the request writes', () => {
    const serializers = buildPinoHttpOptions({ level: 'info' }).serializers
    const req = serializers?.['req'] as (value: object) => { url: string }

    expect(req({ url: handshake('s3cret') }).url).not.toContain('s3cret')
  })
})

describe('scrubRequest', () => {
  // Built, not written out: a literal that long reads as a secret to the scanner of the hooks
  const TOKEN = `fixture-${'0123456789'.repeat(3)}`

  it('removes the token from the url, with or without what follows it', () => {
    expect(scrubRequest({ url: `/api/v1/invitations/${TOKEN}` }).url).toBe(
      '/api/v1/invitations/[redacted]'
    )
    expect(scrubRequest({ url: `/api/v1/invitations/${TOKEN}/accept?x=1` }).url).toBe(
      '/api/v1/invitations/[redacted]/accept?x=1'
    )
  })

  it('removes it from the params, whether the route is matched or still a wildcard', () => {
    const matched = scrubRequest({ params: { token: TOKEN } })
    const wildcard = scrubRequest({
      params: { splat: ['api', 'v1', 'invitations', TOKEN, 'accept'] }
    })

    expect(JSON.stringify(matched)).not.toContain(TOKEN)
    expect(JSON.stringify(wildcard)).not.toContain(TOKEN)
    expect(wildcard.params).toEqual({ splat: ['api', 'v1', 'invitations', '[redacted]', 'accept'] })
  })

  // What the real log holds: Nest strips the global prefix from the wildcard params
  it('removes it from the params as the app really logs them, without the prefix', () => {
    const logged = scrubRequest({ params: { splat: ['invitations', TOKEN, 'accept'] } })

    expect(JSON.stringify(logged)).not.toContain(TOKEN)
    expect(logged.params).toEqual({ splat: ['invitations', '[redacted]', 'accept'] })
  })

  it('does not care about the case of the path, which the router does not either', () => {
    const url = scrubRequest({ url: `/API/V1/Invitations/${TOKEN}` }).url
    const splat = scrubRequest({ params: { splat: ['Invitations', TOKEN] } }).params

    expect(url).not.toContain(TOKEN)
    expect(JSON.stringify(splat)).not.toContain(TOKEN)
  })

  it('leaves the other routes alone, the id of an invitation in the team settings included', () => {
    const team = '/api/v1/settings/team/invitations/6c1f3c0e-6a58-4a40-9d0d-3f0c8a1b2c3d'
    const others = {
      url: team,
      params: { splat: ['api', 'v1', 'settings', 'team', 'invitations', 'x'] }
    }

    expect(scrubRequest(others)).toEqual(others)
    expect(scrubRequest({ url: '/api/v1/conversations?invitations=1' }).url).toBe(
      '/api/v1/conversations?invitations=1'
    )
  })

  it('is wired into the serializer of the request', () => {
    const serializers = buildPinoHttpOptions({ level: 'info' }).serializers
    const req = serializers?.['req'] as (value: object) => { url: string }

    expect(req({ url: `/api/v1/invitations/${TOKEN}` }).url).not.toContain(TOKEN)
  })
})

describe('redactedPathsFor, the keys a plugin declares', () => {
  const declared = ['acmeSecret', 'acme_token_x']

  function logged(payload: object, keys: readonly string[]): string {
    let output = ''
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString()
        done()
      }
    })
    pino({ redact: { paths: redactedPathsFor(keys), remove: true } }, stream).info(payload, 'x')
    return output
  }

  describe.each(declared)('the declared key %s', key => {
    it.each([0, 1, 2, 3, 4])('is removed at %i levels of depth', depth => {
      let payload: Record<string, unknown> = { [key]: 'leak-value' }
      for (let level = 0; level < depth; level += 1) payload = { [`layer${level}`]: payload }

      const output = logged({ ...payload, kept: 'still-here' }, declared)

      expect(output).not.toContain('leak-value')
      expect(output).toContain('still-here')
    })
  })

  it('keeps every path of the core and removes nothing else', () => {
    expect(redactedPathsFor([])).toEqual([...REDACTED_PATHS])
    expect(logged({ other: 'visible', credentials: { x: 'leak' } }, declared)).not.toContain('leak')
    expect(logged({ other: 'visible' }, declared)).toContain('visible')
  })

  it('is what the options of the http logger redact', () => {
    const options = buildPinoHttpOptions({ level: 'debug', redactedKeys: declared })
    expect(options.redact).toEqual({ paths: redactedPathsFor(declared), remove: true })
  })
})

// S13: what the real options of the logger write, with the real pino. The exact paths cannot know a name nobody
// listed; the walk by name can, at any depth and in the error of an HTTP client.
describe('redaction by the name of the field', () => {
  function line(payload: object, redactedKeys: readonly string[] = []): string {
    let output = ''
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString()
        done()
      }
    })
    const { redact, formatters, serializers } = buildPinoHttpOptions({
      level: 'info',
      redactedKeys
    })
    pino({ redact, formatters, serializers }, stream).info(payload, 'event')
    return output
  }

  it('removes a secret with a name nobody listed, deeper than the paths reach', () => {
    const output = line({
      job: {
        data: { a: { b: { c: { d: { e: { sessionToken: 'leak-1', widgetSecret: 'leak-2' } } } } } }
      },
      ctx: { 'x-hub-signature-256': 'leak-3', Cookie: 'leak-4', ownerPassword: 'leak-5' },
      meta: { idempotency_key: 'leak-6' }
    })
    for (let n = 1; n <= 6; n += 1) expect(output).not.toContain(`leak-${n}`)
  })

  it('removes the config and headers of the error of an HTTP client, whatever the key of the log', () => {
    const failure = Object.assign(new Error('Request failed with status code 403'), {
      config: { headers: { Authorization: 'Bearer leak-1', 'X-Api-Key': 'leak-2' } },
      response: { headers: { 'set-cookie': ['sid=leak-3'] } }
    })
    const output = line({ err: failure, cause: failure, error: { inner: failure } })
    for (let n = 1; n <= 3; n += 1) expect(output).not.toContain(`leak-${n}`)
    expect(output).toContain('Request failed with status code 403')
  })

  it('redacts the request and response the http logger serializes', () => {
    const { serializers } = buildPinoHttpOptions({ level: 'info' })
    const request = serializers?.['req'] as (value: unknown) => unknown
    const response = serializers?.['res'] as (value: unknown) => unknown
    const text = JSON.stringify([
      request({ method: 'GET', url: '/x', headers: { 'x-signing-key': 'leak-1', accept: 'json' } }),
      response({ statusCode: 200, headers: { 'Set-Cookie': 'sid=leak-2', etag: 'kept' } })
    ])
    expect(text).not.toContain('leak-')
    for (const kept of ['json', 'kept', '/x']) expect(text).toContain(kept)
  })

  it('keeps the format of an ordinary line, and the counters whose names look like a secret', () => {
    const output = JSON.parse(
      line({ storeId: 's1', tokenCount: 7, nested: { attempt: 2 } })
    ) as Record<string, unknown>
    expect(output).toMatchObject({
      storeId: 's1',
      tokenCount: 7,
      nested: { attempt: 2 },
      msg: 'event'
    })
  })

  it('removes the names a plugin declared', () => {
    expect(line({ ctx: { acmeBadge: 'leak-1' } }, ['acmeBadge'])).not.toContain('leak-1')
  })

  function lineOf(call: (logger: ReturnType<typeof pino>) => void): string {
    let output = ''
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString()
        done()
      }
    })
    const { redact, formatters, serializers, hooks } = buildPinoHttpOptions({ level: 'info' })
    call(pino({ redact, formatters, serializers, hooks }, stream))
    return output
  }

  it('scrubs the text of the message, with and without an object', () => {
    const text =
      'connect failed redis://:real-pw@cache:6379 token eyJhbGciOiJI.eyJzdWIiOiIx.abcd1234'
    const withObject = lineOf(logger => logger.error({ storeId: 's1' }, text))
    const alone = lineOf(logger => logger.error(text))
    const interpolated = lineOf(logger => logger.error({ storeId: 's1' }, 'failed: %s', text))
    for (const output of [withObject, alone, interpolated]) {
      expect(output).not.toContain('real-pw')
      expect(output).not.toContain('eyJhbGci')
      expect(output).toContain('connect failed')
    }
  })

  it('does not raise on a getter of the first level, and keeps the line', () => {
    const hostile = {
      storeId: 's1',
      get boom(): string {
        throw new Error('getter')
      }
    }
    let output = ''
    expect(() => {
      output = lineOf(logger => logger.info(hostile, 'event'))
    }).not.toThrow()
    expect(output).toContain('event')
  })

  it('redacts what it keeps of a large payload and cuts the rest', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 20000 }, (_, index) => [`field${index}`, { token: `leak-${index}` }])
    )
    const output = line({ wide, first: { token: 'leak-first' } })
    expect(output).not.toContain('leak-')
    expect(output).toContain('[truncated]')
  })

  it('keeps the class name of an error that pino-http already serialized, and never throws', () => {
    const { serializers } = buildPinoHttpOptions({ level: 'info' })
    const err = serializers?.['err'] as (value: unknown) => Record<string, unknown>
    const serialized = err({
      type: 'AxiosError',
      message: 'boom',
      config: { headers: { Authorization: 'x' } }
    })
    expect(serialized['type']).toBe('AxiosError')
    expect(JSON.stringify(serialized)).not.toContain('"x"')
    const hostile = {
      get boom(): string {
        throw new Error('getter')
      }
    }
    expect(() => line({ hostile })).not.toThrow()
  })
})
