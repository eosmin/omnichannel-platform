import type { IncomingMessage, ServerResponse } from 'node:http'
import { Writable } from 'node:stream'

import { pino } from 'pino'

import { InfraRoutes } from '@platform/core/api'

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
