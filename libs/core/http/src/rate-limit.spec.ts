import { Controller, Get, type INestApplication } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import * as Sentry from '@sentry/nestjs'

import { API_PREFIX } from '@platform/core/api'
import { ThrottlerNames } from '@platform/core/auth'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { configureHttpApp } from './configure-http-app'
import { HttpErrorsModule } from './http-errors.module'
import { RateLimit } from './throttler'

jest.mock('@sentry/nestjs', () => ({
  withScope: (callback: (scope: Record<string, jest.Mock>) => void) =>
    callback({ setContext: jest.fn(), setUser: jest.fn(), setTag: jest.fn() }),
  captureException: jest.fn()
}))

@Controller()
class RoutesController {
  @Get('default')
  byDefault(): { ok: true } {
    return { ok: true }
  }

  @RateLimit({ limit: 2, ttlMs: 60_000 })
  @Get('strict')
  strict(): { ok: true } {
    return { ok: true }
  }

  @SkipThrottle()
  @Get('probe')
  probe(): { ok: true } {
    return { ok: true }
  }
}

async function startApp(trustProxyHops: number): Promise<{ app: INestApplication; url: string }> {
  const module = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({ level: 'fatal', pretty: false }),
      MetricsModule,
      HttpErrorsModule,
      // The default profile of the test is tiny; production reads it from ThrottleProfiles
      ThrottlerModule.forRoot([{ name: ThrottlerNames.DEFAULT, ttl: 60_000, limit: 3 }])
    ],
    controllers: [RoutesController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
  }).compile()
  const app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true })
  app.set('trust proxy', trustProxyHops)
  await configureHttpApp(app) // The correlation id and the error contract, as in the apps
  await app.listen(0)
  return { app, url: await app.getUrl() }
}

describe('the rate limit', () => {
  describe('with no proxy in front', () => {
    let app: INestApplication
    let url: string

    // A fresh app per test: the counters live in the app, and a test must not depend on what the
    // one before it spent
    beforeEach(async () => {
      ;({ app, url } = await startApp(0))
    })
    afterEach(() => app.close())

    it('refuses the request past a route limit with the contract, and says when to come back', async () => {
      await fetch(`${url}${API_PREFIX}/strict`)
      await fetch(`${url}${API_PREFIX}/strict`)

      const refused = await fetch(`${url}${API_PREFIX}/strict`)

      expect(refused.status).toBe(429)
      const body = (await refused.json()) as { error: { code: string }; correlationId: string }
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED')
      expect(body.correlationId).toBeDefined()
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    })

    it('reports the limit and what is left on the requests it lets through', async () => {
      const response = await fetch(`${url}${API_PREFIX}/default`)

      expect(response.status).toBe(200)
      expect(response.headers.get('x-ratelimit-limit')).toBe('3')
      expect(response.headers.get('x-ratelimit-remaining')).toBe('2')
    })

    it('counts each route on its own', async () => {
      await fetch(`${url}${API_PREFIX}/strict`)
      await fetch(`${url}${API_PREFIX}/strict`)

      expect((await fetch(`${url}${API_PREFIX}/strict`)).status).toBe(429) // Spent
      expect((await fetch(`${url}${API_PREFIX}/default`)).status).toBe(200) // Untouched
    })

    it('does not count a route that opts out', async () => {
      for (let i = 0; i < 10; i += 1)
        expect((await fetch(`${url}${API_PREFIX}/probe`)).status).toBe(200)
    })

    it('does not report a refused request as an incident', async () => {
      jest.mocked(Sentry.captureException).mockClear()
      await fetch(`${url}${API_PREFIX}/strict`)
      await fetch(`${url}${API_PREFIX}/strict`)

      expect((await fetch(`${url}${API_PREFIX}/strict`)).status).toBe(429)

      expect(Sentry.captureException).not.toHaveBeenCalled()
    })
  })

  describe('against a client that lies about its address', () => {
    it('cannot dodge the limit with X-Forwarded-For when no proxy is trusted', async () => {
      const { app, url } = await startApp(0)
      try {
        const statuses: number[] = []
        for (let i = 0; i < 4; i += 1) {
          const response = await fetch(`${url}${API_PREFIX}/default`, {
            headers: { 'x-forwarded-for': `203.0.113.${i + 1}` }
          })
          statuses.push(response.status)
        }

        expect(statuses).toEqual([200, 200, 200, 429])
      } finally {
        await app.close()
      }
    })

    it('believes only the address the proxy added, not the ones the client wrote before it', async () => {
      const { app, url } = await startApp(1)
      try {
        // The client invents a new address on every request; the proxy appends the real one at the end
        const statuses: number[] = []
        for (let i = 0; i < 4; i += 1) {
          const response = await fetch(`${url}${API_PREFIX}/default`, {
            headers: { 'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.50` }
          })
          statuses.push(response.status)
        }

        expect(statuses).toEqual([200, 200, 200, 429])
      } finally {
        await app.close()
      }
    })

    it('counts the clients behind a trusted proxy by the address it forwards', async () => {
      const { app, url } = await startApp(1)
      try {
        const from = (ip: string): Promise<Response> =>
          fetch(`${url}${API_PREFIX}/default`, { headers: { 'x-forwarded-for': ip } })
        for (let i = 0; i < 3; i += 1) await from('203.0.113.7')

        expect((await from('203.0.113.7')).status).toBe(429)
        expect((await from('203.0.113.8')).status).toBe(200) // Another client, its own count
      } finally {
        await app.close()
      }
    })
  })
})
