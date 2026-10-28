import type { IncomingMessage, ServerResponse } from 'node:http'
import { Writable } from 'node:stream'

import { pino } from 'pino'

import { InfraRoutes } from '@platform/core/api'
import { REDACTED, SENSITIVE_QUERY_PARAMS } from '@platform/core/domain'

import type { AuthenticatedRequest } from './authenticated-request'
import { buildPinoHttpOptions, logLevelFor, REDACTED_PATHS, scrubRequest } from './logger-options'

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

  it('removes credentials and secrets from what is logged', () => {
    const output = logged({
      req: {
        headers: {
          authorization: 'Bearer abc',
          cookie: 'sid=1',
          'x-api-key': 'k',
          'proxy-authorization': 'Basic xyz',
          'x-hub-signature-256': 'sha256=deadbeef',
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
      'Basic xyz',
      'deadbeef'
    ]) {
      expect(output).not.toContain(secret)
    }
    for (const kept of ['json', '"ok"', 'kept']) expect(output).toContain(kept)
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
