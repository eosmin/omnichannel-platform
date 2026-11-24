import { Controller, Get, type INestApplication, Logger } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { getStorageToken, ThrottlerModule, type ThrottlerStorage } from '@nestjs/throttler'

import { RETRY_AFTER_METADATA_KEY, ThrottlerNames } from '@platform/core/auth'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { configureHttpApp } from '../configure-http-app'
import { HttpErrorsModule } from '../http-errors.module'

import { ResilientThrottlerGuard } from './resilient-throttler.guard'

@Controller()
class PingController {
  @Get('ping')
  ping(): { ok: true } {
    return { ok: true }
  }
}

// A storage that answers like Redis does: with hits counted, or with an error
function storageWith(behaviour: { fail: boolean }): ThrottlerStorage {
  let hits = 0
  return {
    increment: () => {
      if (behaviour.fail) return Promise.reject(new Error('ECONNREFUSED 10.0.0.9:6379'))
      hits += 1
      return Promise.resolve({
        totalHits: hits,
        timeToExpire: 60,
        isBlocked: hits > 2,
        timeToBlockExpire: 60
      })
    }
  }
}

describe('ResilientThrottlerGuard', () => {
  const behaviour = { fail: false }
  let app: INestApplication
  let url: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        HttpErrorsModule,
        ThrottlerModule.forRoot({
          throttlers: [{ name: ThrottlerNames.DEFAULT, ttl: 60_000, limit: 2 }],
          storage: storageWith(behaviour)
        })
      ],
      controllers: [PingController],
      providers: [{ provide: APP_GUARD, useClass: ResilientThrottlerGuard }]
    }).compile()
    expect(module.get(getStorageToken())).toBeDefined()
    app = module.createNestApplication({ bufferLogs: true })
    await configureHttpApp(app)
    await app.listen(0)
    url = await app.getUrl()
  })
  afterAll(() => app.close())

  it('refuses past the limit, as the plain guard does', async () => {
    const statuses = []
    for (let i = 0; i < 3; i += 1) statuses.push((await fetch(`${url}/api/v1/ping`)).status)

    expect(statuses).toEqual([200, 200, 429])
  })

  // H-11: a client that is refused has to be told how long to wait and what the limit is, in headers (a proxy or a script does not read bodies)
  it('tells the refused client the limit, what is left and when it resets, in headers', async () => {
    const refused = await fetch(`${url}/api/v1/ping`)

    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('60')
    expect(refused.headers.get('x-ratelimit-limit')).toBe('2')
    expect(refused.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(refused.headers.get('x-ratelimit-reset')).toBe('60')
    // The same wait is in the body, where the web reads it
    const body = (await refused.json()) as { error: { metadata: Record<string, unknown> } }
    expect(body.error.metadata[RETRY_AFTER_METADATA_KEY]).toBe(60)
  })

  it('lets the request through, without a 500, when the storage fails, and logs why', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    behaviour.fail = true

    const response = await fetch(`${url}/api/v1/ping`)

    expect(response.status).toBe(200)
    expect(String(error.mock.calls[0]?.[0])).toContain('rate limit storage failed')
    behaviour.fail = false
    error.mockRestore()
  })
})
