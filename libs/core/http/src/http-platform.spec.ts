import {
  Controller,
  Get,
  Global,
  type INestApplication,
  Module,
  Res,
  ServiceUnavailableException
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as Sentry from '@sentry/nestjs'
import type { Response } from 'express'

import { PrismaService } from '@platform/core/database'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { configureHttpApp } from './configure-http-app'
import { HealthModule } from './health/health.module'
import { HttpErrorsModule } from './http-errors.module'

jest.mock('@sentry/nestjs', () => ({
  withScope: (callback: (scope: Record<string, jest.Mock>) => void) =>
    callback({ setContext: jest.fn(), setUser: jest.fn(), setTag: jest.fn() }),
  captureException: jest.fn()
}))

@Controller()
class ProbeController {
  @Get('ping')
  ping(): { pong: true } {
    return { pong: true }
  }

  @Get('business')
  business(): never {
    throw new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, 'order 7 not found', 404, {
      id: '7'
    })
  }

  @Get('tenant')
  tenant(): never {
    throw new PlatformException(ErrorCodes.TENANT_ACCESS_DENIED, 'another store', 403)
  }

  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException('replica 10.0.0.7 is not reachable')
  }

  @Get('half')
  half(@Res() response: Response): never {
    response.write('partial')
    throw new Error('failed halfway')
  }

  @Get('crash')
  crash(): never {
    throw new Error('password=hunter2 leaked in a stack')
  }
}

// The database the readiness probe asks, replaced by one the test can break
const database = { queryRaw: jest.fn<Promise<unknown>, []>() }

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: { client: { $queryRaw: () => database.queryRaw() } } }
  ],
  exports: [PrismaService]
})
class FakeDatabaseModule {}

interface ErrorBody {
  error: { code: string; message: string; metadata: Record<string, unknown> }
  correlationId: string
}

describe('the HTTP platform', () => {
  let app: INestApplication
  let baseUrl: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        FakeDatabaseModule,
        HttpErrorsModule,
        HealthModule
      ],
      controllers: [ProbeController]
    }).compile()
    app = module.createNestApplication({ bufferLogs: true })
    await configureHttpApp(app)
    await app.listen(0)
    baseUrl = await app.getUrl()
  })

  afterAll(() => app.close())

  beforeEach(() => {
    database.queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }])
    jest.mocked(Sentry.captureException).mockClear()
  })

  describe('health', () => {
    it('answers liveness without touching the database', async () => {
      const response = await fetch(`${baseUrl}/health`)
      expect(response.status).toBe(200)
      expect(database.queryRaw).not.toHaveBeenCalled()
    })

    it('answers readiness when the database answers', async () => {
      const response = await fetch(`${baseUrl}/health/ready`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' } }
      })
    })

    it('refuses readiness when the database is down, and liveness stays up', async () => {
      database.queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:6432'))
      expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503)
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200)
    })

    it('names the check that failed, in the error contract, without its message', async () => {
      database.queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:6432'))
      const response = await fetch(`${baseUrl}/health/ready`)
      const text = await response.text()
      const body = JSON.parse(text) as ErrorBody
      expect(body.error.metadata).toEqual({ checks: { database: 'down' } })
      expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(text).not.toContain('10.0.0.7')
    })

    it('refuses readiness when the database does not answer in time', async () => {
      database.queryRaw.mockReturnValue(new Promise(() => undefined))
      expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503)
    }, 10_000)
  })

  describe('routes outside and inside the prefix', () => {
    it('serves the infra routes without the /api/v1 prefix', async () => {
      expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200)
      expect((await fetch(`${baseUrl}/api/v1/metrics`)).status).toBe(404)
      expect((await fetch(`${baseUrl}/api/v1/health`)).status).toBe(404)
    })

    it('counts the requests by route pattern, the ones outside the prefix and the probes apart', async () => {
      await fetch(`${baseUrl}/api/v1/ping`)
      await fetch(`${baseUrl}/robots.txt`)
      await fetch(`${baseUrl}/health`)
      const scrape = await (await fetch(`${baseUrl}/metrics`)).text()
      expect(scrape).toContain(
        'http_requests_total{method="GET",route="/api/v1/ping",status_code="200"}'
      )
      expect(scrape).toContain(
        'http_requests_total{method="GET",route="unmatched",status_code="404"}'
      )
      expect(scrape).not.toContain('route="/health"')
      expect(scrape).not.toContain('route="/metrics"')
    })

    it('serves the controllers under /api/v1 only', async () => {
      expect(await (await fetch(`${baseUrl}/api/v1/ping`)).json()).toEqual({ pong: true })
      expect((await fetch(`${baseUrl}/ping`)).status).toBe(404)
    })
  })

  describe('the error contract', () => {
    async function errorOf(
      path: string
    ): Promise<{ status: number; body: ErrorBody; header: string | null }> {
      const response = await fetch(`${baseUrl}${path}`)
      return {
        status: response.status,
        body: (await response.json()) as ErrorBody,
        header: response.headers.get('x-correlation-id')
      }
    }

    it('answers an unknown route with the contract and the correlation id of the request', async () => {
      const { status, body, header } = await errorOf('/api/v1/unknown')
      expect(status).toBe(404)
      expect(body.error.code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      expect(body.error.metadata).toEqual({})
      expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(header).toBe(body.correlationId)
    })

    it('answers an unknown path outside the prefix with the contract too', async () => {
      const { status, body } = await errorOf('/robots.txt')
      expect(status).toBe(404)
      expect(body.error.code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('carries a business error as it was raised', async () => {
      const { status, body } = await errorOf('/api/v1/business')
      expect(status).toBe(404)
      expect(body.error).toEqual({
        code: ErrorCodes.RESOURCE_NOT_FOUND,
        message: 'order 7 not found',
        metadata: { id: '7' }
      })
      expect(Sentry.captureException).not.toHaveBeenCalled()
    })

    it('counts an attempt to reach another tenant', async () => {
      const { status, body } = await errorOf('/api/v1/tenant')
      expect(status).toBe(403)
      expect(body.error.code).toBe(ErrorCodes.TENANT_ACCESS_DENIED)
      const scrape = await (await fetch(`${baseUrl}/metrics`)).text()
      expect(scrape).toContain('platform_tenant_violations_total{resource="/api/v1/tenant"} 1')
    })

    it('hides the message of a server failure and reports it, but not a failing probe', async () => {
      const { status, body } = await errorOf('/api/v1/unavailable')
      expect(status).toBe(503)
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR)
      expect(body.error.message).toBe('An unexpected error occurred')
      expect(Sentry.captureException).toHaveBeenCalledTimes(1)

      jest.mocked(Sentry.captureException).mockClear()
      database.queryRaw.mockRejectedValue(new Error('down'))
      expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503)
      expect(Sentry.captureException).not.toHaveBeenCalled()
    })

    it('survives an error after the response started', async () => {
      const response = await fetch(`${baseUrl}/api/v1/half`)
      await response.text().catch(() => undefined)
      expect((await fetch(`${baseUrl}/api/v1/ping`)).status).toBe(200)
    })

    it('hides an unexpected error from the client and reports it', async () => {
      const { status, body } = await errorOf('/api/v1/crash')
      expect(status).toBe(500)
      expect(body.error).toEqual({
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
        metadata: {}
      })
      expect(JSON.stringify(body)).not.toContain('hunter2')
      expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    })
  })
})
