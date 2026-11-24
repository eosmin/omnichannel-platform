import type { Counter } from '@prometheus-io/client'
import type { Redis } from 'ioredis'
import type { PinoLogger } from 'nestjs-pino'

import type { AuditService } from '@platform/core/audit-module'
import { RETRY_AFTER_METADATA_KEY, UnsubscribeTokenThrottle } from '@platform/core/auth'
import type { JobContext, PrismaService } from '@platform/core/database'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { NotificationUnsubscribeService } from './notification-unsubscribe.service'

// Only the rate limit is under test here (the rest of the route has its spec against a database in tests/api)
function serviceWith(redisAnswer: unknown): NotificationUnsubscribeService {
  const redis = { eval: jest.fn().mockResolvedValue(redisAnswer) } as unknown as Redis
  const logger = { setContext: jest.fn() } as unknown as PinoLogger
  return new NotificationUnsubscribeService(
    {} as PrismaService,
    {} as JobContext,
    {} as AuditService,
    redis,
    [],
    { inc: jest.fn() } as unknown as Counter<string>,
    logger
  )
}

describe('NotificationUnsubscribeService, the rate limit', () => {
  it('refuses with 429 and says in whole seconds how long is left of the window (H-11)', async () => {
    // [count, milliseconds left of the window]
    const service = serviceWith([UnsubscribeTokenThrottle.limit + 1, 421_500])

    const error = await service.unsubscribe('any-token').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformException)
    const refusal = error as PlatformException
    expect(refusal.code).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
    expect(refusal.statusCode).toBe(HttpStatusCodes.TOO_MANY_REQUESTS)
    expect(refusal.metadata).toEqual({ [RETRY_AFTER_METADATA_KEY]: 422 })
  })

  it('never says to wait less than one second, whatever the store answers for the time left', async () => {
    for (const left of [0, -1, -2]) {
      const service = serviceWith([UnsubscribeTokenThrottle.limit + 1, left])
      const error = (await service
        .unsubscribe('any-token')
        .catch((e: unknown) => e)) as PlatformException
      expect(error.metadata?.[RETRY_AFTER_METADATA_KEY]).toBe(1)
    }
  })
})
