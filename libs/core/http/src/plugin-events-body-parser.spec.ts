import { EventEmitter } from 'node:events'

import { Body, Controller, type INestApplication, Post } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { RequestHandler } from 'express'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { PLUGIN_API_KEY_TOKEN_PREFIX, RemoteChannelApiLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { configureHttpApp } from './configure-http-app'
import { HttpErrorsModule } from './http-errors.module'
import { pluginEventsBodyParser } from './plugin-events-body-parser'
import { PluginKeyProbeLimiter } from './throttler/plugin-key-probe-limiter'

// What the route sees of the body: how big it was and that it arrived parsed
@Controller()
class EchoController {
  @Post(PluginApiRoutes.channel.events.slice(1))
  events(@Body() body: { events?: unknown[] } | undefined): { count: number } {
    return { count: body?.events?.length ?? -1 }
  }

  @Post('other')
  other(@Body() body: { events?: unknown[] } | undefined): { count: number } {
    return { count: body?.events?.length ?? -1 }
  }
}

const KEY = `Bearer ${PLUGIN_API_KEY_TOKEN_PREFIX}abc`
// A batch of this many bytes, of which the text is most
const batchOf = (bytes: number): string => JSON.stringify({ events: [{ text: 'x'.repeat(bytes) }] })

// The one route of the api that reads more than 100 KB, and only for a caller that carries a plugin key (TDD_10 §6.7.5)
describe('the body parser of POST /plugin-api/channel/events', () => {
  let app: INestApplication
  let url: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        HttpErrorsModule
      ],
      controllers: [EchoController]
    }).compile()
    app = module.createNestApplication({ bufferLogs: true, rawBody: true })
    await configureHttpApp(app)
    await app.listen(0)
    url = await app.getUrl()
  })
  afterAll(() => app.close())

  const post = (
    path: string,
    body: string,
    headers: Record<string, string> = {}
  ): Promise<Response> =>
    fetch(`${url}${API_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body
    })
  const events = (body: string, headers: Record<string, string> = { authorization: KEY }) =>
    post(PluginApiRoutes.channel.events, body, headers)
  const codeOf = async (response: Response): Promise<string> =>
    ((await response.json()) as { error: { code: string } }).error.code

  it('reads a body past 100 KB and up to 1 MiB from a caller that carries a plugin key', async () => {
    const response = await events(batchOf(300 * 1024))

    expect(response.status).toBe(HttpStatusCodes.CREATED)
    expect(await response.json()).toEqual({ count: 1 })
  })

  it('refuses a body past 1 MiB with 413, by what it declares and by what it sends', async () => {
    const response = await events(batchOf(RemoteChannelApiLimits.EVENTS_BODY_MAX_BYTES + 1))

    expect(response.status).toBe(HttpStatusCodes.PAYLOAD_TOO_LARGE)
    expect(await codeOf(response)).toBe(ErrorCodes.PAYLOAD_TOO_LARGE)
  })

  it('refuses a body past 1 MiB that is sent in chunks with no length declared', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('{"events":[{"text":"'))
        for (
          let sent = 0;
          sent < RemoteChannelApiLimits.EVENTS_BODY_MAX_BYTES;
          sent += chunk.length
        )
          controller.enqueue(chunk)
        controller.enqueue(new TextEncoder().encode('"}]}'))
        controller.close()
      }
    })
    const response = await fetch(`${url}${API_PREFIX}${PluginApiRoutes.channel.events}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: KEY },
      body: stream,
      duplex: 'half'
    })

    expect(response.status).toBe(HttpStatusCodes.PAYLOAD_TOO_LARGE)
  })

  it('keeps the 100 KB for a caller with no key, or a header that is not a plugin key', async () => {
    const withoutKey: Record<string, string>[] = [
      {},
      { authorization: 'Bearer eyJhbGciOi' },
      { authorization: KEY.slice(0, 6) }
    ]
    for (const headers of withoutKey) {
      const response = await events(batchOf(300 * 1024), headers)

      expect(response.status).toBe(HttpStatusCodes.PAYLOAD_TOO_LARGE)
    }
  })

  it('keeps the 100 KB on every other route, key or not', async () => {
    const response = await post('/other', batchOf(300 * 1024), { authorization: KEY })

    expect(response.status).toBe(HttpStatusCodes.PAYLOAD_TOO_LARGE)
  })

  it('leaves a small body, and a body that is not JSON, to the parser of every route', async () => {
    expect((await events(batchOf(10))).status).toBe(HttpStatusCodes.CREATED)
    const notJson = await events('{"events":', { authorization: KEY })
    expect(notJson.status).toBe(HttpStatusCodes.BAD_REQUEST)
    const text = await events(batchOf(300 * 1024), {
      authorization: KEY,
      'content-type': 'text/plain'
    })
    // Not parsed by anybody: the route sees no events, and the big body was not read
    expect(await text.json()).toEqual({ count: -1 })
  })

  it('refuses a body that is a scalar, as Nest does', async () => {
    expect((await events('"events"')).status).toBe(HttpStatusCodes.BAD_REQUEST)
  })
})

// Step 7.3, PR S3: the limit of the keys that failed is asked before a byte of the large body is read
describe('the body parser of POST /plugin-api/channel/events with the limit of the failed keys', () => {
  let app: INestApplication
  let url: string
  const waitFor = jest.fn<Promise<number>, [string]>()

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        HttpErrorsModule
      ],
      controllers: [EchoController],
      providers: [{ provide: PluginKeyProbeLimiter, useValue: { retryAfter: waitFor } }]
    }).compile()
    app = module.createNestApplication({ bufferLogs: true, rawBody: true })
    await configureHttpApp(app)
    await app.listen(0)
    url = await app.getUrl()
  })
  afterAll(() => app.close())
  beforeEach(() => waitFor.mockReset().mockResolvedValue(0))

  const events = (body: string): Promise<Response> =>
    fetch(`${url}${API_PREFIX}${PluginApiRoutes.channel.events}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: KEY },
      body
    })

  it('reads the large body for an address that is free', async () => {
    const response = await events(batchOf(300 * 1024))

    expect(response.status).toBe(HttpStatusCodes.CREATED)
    expect(waitFor).toHaveBeenCalledTimes(1)
  })

  it('answers 429 with the time to wait, and never a 413 for a good batch, when the address has to wait', async () => {
    waitFor.mockResolvedValue(30)

    const response = await events(batchOf(300 * 1024))

    expect(response.status).toBe(HttpStatusCodes.TOO_MANY_REQUESTS)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.RATE_LIMIT_EXCEEDED
    )
  })

  it('does not ask the limit when no large read would happen (no key, or not JSON)', async () => {
    await fetch(`${url}${API_PREFIX}${PluginApiRoutes.channel.events}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: batchOf(10)
    })
    await fetch(`${url}${API_PREFIX}${PluginApiRoutes.channel.events}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: KEY },
      body: 'x'
    })

    expect(waitFor).not.toHaveBeenCalled()
  })

  it('does not ask the limit for any other route', async () => {
    await fetch(`${url}${API_PREFIX}/other`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: KEY },
      body: batchOf(10)
    })

    expect(waitFor).not.toHaveBeenCalled()
  })

  it('goes on and reads when the limit cannot answer', async () => {
    waitFor.mockRejectedValue(new Error('down'))

    expect((await events(batchOf(10))).status).toBe(HttpStatusCodes.CREATED)
  })
})

// The reads in flight of one address, with requests whose body never ends so that they stay in flight
describe('the large reads of one address in flight', () => {
  const cap = RemoteChannelApiLimits.EVENTS_CONCURRENT_READS_PER_ADDRESS

  function call(
    handler: RequestHandler,
    ip: string | undefined
  ): { next: jest.Mock; response: EventEmitter } {
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      path: `${API_PREFIX}${PluginApiRoutes.channel.events}`,
      ip,
      headers: { authorization: KEY, 'content-type': 'application/json' },
      pause: jest.fn(),
      destroy: jest.fn()
    })
    const response = Object.assign(new EventEmitter(), { setHeader: jest.fn() })
    const next = jest.fn()
    handler(request as never, response as never, next)
    return { next, response }
  }
  // A read that is in flight has not called next yet; a refusal has, at once, with the 429
  const refused = (next: jest.Mock): boolean => {
    const calls = next.mock.calls as unknown[][]
    const answer = calls[0]?.[0] as { statusCode?: number } | undefined
    return calls.length === 1 && answer?.statusCode === HttpStatusCodes.TOO_MANY_REQUESTS
  }

  it('refuses the read past the cap of an address with a 429 and gives the place back when a response closes', () => {
    const handler = pluginEventsBodyParser()
    const inFlight = Array.from({ length: cap }, () => call(handler, '203.0.113.7'))
    expect(inFlight.every(({ next }) => next.mock.calls.length === 0)).toBe(true)

    expect(refused(call(handler, '203.0.113.7').next)).toBe(true)

    inFlight[0]?.response.emit('close')
    expect(call(handler, '203.0.113.7').next.mock.calls.length).toBe(0)
  })

  it('counts each address on its own, and none for a call with no address', () => {
    const handler = pluginEventsBodyParser()
    for (let i = 0; i < cap; i += 1) call(handler, '203.0.113.7')

    expect(call(handler, '198.51.100.9').next.mock.calls.length).toBe(0)
    for (let i = 0; i < cap + 2; i += 1) {
      expect(call(handler, undefined).next.mock.calls.length).toBe(0)
    }
  })
})
