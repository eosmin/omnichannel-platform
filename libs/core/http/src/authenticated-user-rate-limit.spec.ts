import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  type INestApplication,
  Injectable
} from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { ThrottlerStorageService } from '@nestjs/throttler'
import type { Request } from 'express'

import { API_PREFIX } from '@platform/core/api'
import { AuthenticatedUserRateLimit } from '@platform/core/auth'
import { LoggerModule } from '@platform/core/logger'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { configureHttpApp } from './configure-http-app'
import { HttpErrorsModule } from './http-errors.module'
import { AuthenticatedUserRateLimitGuard, USER_RATE_LIMIT_STORAGE } from './throttler'

// Stands for the AuthGuard: the person is whoever the header says
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>()
    const id = request.header('x-test-user')
    if (id !== undefined) request.user = { id, sessionFamilyId: 's', email: 'a@example.org' }
    return true
  }
}

@Controller()
class RoutesController {
  @Get('anything')
  anything(): { ok: true } {
    return { ok: true }
  }
}

describe('the general per-user budget, wired as a global guard after the authentication', () => {
  let app: INestApplication
  let url: string

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        HttpErrorsModule
      ],
      controllers: [RoutesController],
      providers: [
        { provide: USER_RATE_LIMIT_STORAGE, useValue: new ThrottlerStorageService() },
        AuthenticatedUserRateLimitGuard,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useExisting: AuthenticatedUserRateLimitGuard }
      ]
    }).compile()
    const nest = module.createNestApplication<NestExpressApplication>({ bufferLogs: true })
    await configureHttpApp(nest)
    await nest.listen(0)
    app = nest
    url = await nest.getUrl()
  })
  afterEach(() => app.close())

  const call = (user: string | undefined, address: string): Promise<Response> =>
    fetch(`${url}${API_PREFIX}/anything`, {
      headers: {
        ...(user === undefined ? {} : { 'x-test-user': user }),
        'x-forwarded-for': address
      }
    })

  it('refuses a person past the budget whatever address the calls come from, and leaves the others alone', async () => {
    for (let i = 0; i < AuthenticatedUserRateLimit.limit; i += 1) {
      expect((await call('u1', `203.0.113.${(i % 250) + 1}`)).status).toBe(200)
    }

    const refused = await call('u1', '198.51.100.9')

    expect(refused.status).toBe(429)
    const body = (await refused.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED')
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await call('u2', '198.51.100.9')).status).toBe(200)
  })

  it('does not count a request with no authenticated person', async () => {
    for (let i = 0; i < AuthenticatedUserRateLimit.limit + 5; i += 1) {
      expect((await call(undefined, '203.0.113.7')).status).toBe(200)
    }
  })
})
