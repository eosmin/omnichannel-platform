import type { IncomingMessage, ServerResponse } from 'node:http'
import { Writable } from 'node:stream'

import { pino } from 'pino'

import { InfraRoutes } from '@platform/core/api'

import type { AuthenticatedRequest } from './authenticated-request'
import { buildPinoHttpOptions, logLevelFor, REDACTED_PATHS } from './logger-options'

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
