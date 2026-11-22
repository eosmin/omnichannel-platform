import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Controller, type INestApplication, type RawBodyRequest, Post, Req } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Request } from 'express'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { carrierWebhookBodyParser } from './carrier-webhook-body-parser'
import { configureHttpApp } from './configure-http-app'
import { HttpErrorsModule } from './http-errors.module'

// What the route sees: the bytes the signature is over and the parsed body
@Controller()
class EchoController {
  @Post(ApiRoutes.webhooks.carrier(':id').slice(1))
  carrier(@Req() req: RawBodyRequest<Request>): { raw: string; body: unknown } {
    return { raw: req.rawBody?.toString('utf8') ?? '', body: req.body as unknown }
  }

  @Post('other')
  other(@Req() req: RawBodyRequest<Request>): { raw: string } {
    return { raw: req.rawBody?.toString('utf8') ?? '' }
  }
}

describe('the body parser of the webhook of a carrier', () => {
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

  const post = (path: string, body: string, contentType = 'application/json'): Promise<Response> =>
    fetch(`${url}${API_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body
    })

  const route = ApiRoutes.webhooks.carrier('c-1')

  it('hands the route the exact bytes and the parsed body of valid JSON', async () => {
    const raw = '{ "events": [ ] }'
    const response = await post(route, raw)

    expect(response.status).toBe(HttpStatusCodes.CREATED)
    expect(await response.json()).toEqual({ raw, body: { events: [] } })
  })

  it.each(['{"events": [', 'not json', '[1,', '{"a":1}}', '"abc"', '123', 'null', 'true'])(
    'answers the uniform 401 for a body that is not JSON (%s), and not the 400 of the parser',
    async body => {
      const response = await post(route, body)

      expect(response.status).toBe(HttpStatusCodes.UNAUTHORIZED)
      const answer = (await response.json()) as { error: { code: string; message: string } }
      expect(answer.error.code).toBe(ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID)
      expect(answer.error.message).toBe('invalid signature')
    }
  )

  it('answers the same when the path is written in other case, which Express routes alike', async () => {
    const response = await post(
      route.replace('webhooks', 'Webhooks').replace('carriers', 'CARRIERS'),
      'not json'
    )
    expect(response.status).toBe(HttpStatusCodes.UNAUTHORIZED)
  })

  it('takes an array as a body, as the strict parser did', async () => {
    const response = await post(route, '[1]')
    expect(response.status).toBe(HttpStatusCodes.CREATED)
  })

  it('refuses a streamed body past the limit, answers with the connection closing and destroys the request once the answer is sent', async () => {
    const request = Object.assign(new PassThrough(), {
      method: 'POST',
      path: `${API_PREFIX}${route}`,
      // No content-length: the size is only known by counting what arrives
      headers: { 'content-type': 'application/json' }
    })
    const destroy = jest.spyOn(request, 'destroy')
    const response = Object.assign(new EventEmitter(), { setHeader: jest.fn() })
    const next = jest.fn<void, [unknown?]>()

    carrierWebhookBodyParser()(request as never, response as never, next)
    request.write(`{"x":"${'x'.repeat(110_000)}`)
    await new Promise(resolve => setImmediate(resolve))

    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: HttpStatusCodes.PAYLOAD_TOO_LARGE })
    expect(response.setHeader).toHaveBeenCalledWith('Connection', 'close')
    expect(destroy).not.toHaveBeenCalled()
    response.emit('finish')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('leaves every other route, and a body that is not JSON there, to Nest', async () => {
    const response = await post('/other', 'not json')
    expect(response.status).toBe(HttpStatusCodes.BAD_REQUEST)
  })
})
