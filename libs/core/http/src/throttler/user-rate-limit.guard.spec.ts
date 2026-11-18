import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { UserRateLimits } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { UserRateLimit, UserRateLimitGuard } from './user-rate-limit.guard'

class Routes {
  @UserRateLimit(UserRateLimits.SEARCH)
  limited(): undefined {
    return undefined
  }

  free(): undefined {
    return undefined
  }
}

const handlerOf = (name: 'limited' | 'free'): (() => void) => Reflect.get(Routes.prototype, name)

const contextOf = (handler: () => void, user: { id: string } | undefined): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ user }) })
  }) as unknown as ExecutionContext

const record = (isBlocked: boolean, wait = 0) => ({
  totalHits: 1,
  timeToExpire: 30,
  isBlocked,
  timeToBlockExpire: wait
})

function build(increment: jest.Mock) {
  const inc = jest.fn()
  const guard = new UserRateLimitGuard(new Reflector(), { increment }, { inc } as never)
  return { guard, inc }
}

describe('UserRateLimitGuard', () => {
  const limited = handlerOf('limited')

  it('counts per user, in the counter of the profile, with the limit of the profile', async () => {
    const increment = jest.fn().mockResolvedValue(record(false))
    const { guard } = build(increment)
    await expect(guard.canActivate(contextOf(limited, { id: 'u1' }))).resolves.toBe(true)
    expect(increment).toHaveBeenCalledWith(
      'u1',
      UserRateLimits.SEARCH.ttlMs,
      UserRateLimits.SEARCH.limit,
      0,
      'user:search'
    )
  })

  it('refuses with a 429 that says how long to wait, and counts the refusal', async () => {
    const { guard, inc } = build(jest.fn().mockResolvedValue(record(true, 17)))
    const refusal: unknown = await guard
      .canActivate(contextOf(limited, { id: 'u1' }))
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(PlatformException)
    expect(refusal).toMatchObject({
      code: ErrorCodes.RATE_LIMIT_EXCEEDED,
      statusCode: HttpStatusCodes.TOO_MANY_REQUESTS,
      metadata: { retryAfterSeconds: 17 }
    })
    expect(inc).toHaveBeenCalledWith({ throttler: 'user:search' })
  })

  it('waits at least a second, never zero', async () => {
    const { guard } = build(jest.fn().mockResolvedValue(record(true, 0)))
    await expect(guard.canActivate(contextOf(limited, { id: 'u1' }))).rejects.toMatchObject({
      metadata: { retryAfterSeconds: 1 }
    })
  })

  it('gives each user a budget of their own: a second user is counted apart', async () => {
    const increment = jest.fn().mockResolvedValue(record(false))
    const { guard } = build(increment)
    await guard.canActivate(contextOf(limited, { id: 'u1' }))
    await guard.canActivate(contextOf(limited, { id: 'u2' }))
    expect(increment).toHaveBeenNthCalledWith(
      1,
      'u1',
      expect.anything(),
      expect.anything(),
      0,
      expect.anything()
    )
    expect(increment).toHaveBeenNthCalledWith(
      2,
      'u2',
      expect.anything(),
      expect.anything(),
      0,
      expect.anything()
    )
  })

  it('lets the request through, and logs, when the storage fails', async () => {
    const { guard } = build(jest.fn().mockRejectedValue(new Error('redis down')))
    await expect(guard.canActivate(contextOf(limited, { id: 'u1' }))).resolves.toBe(true)
  })

  it('does not count a route that asked for no limit', async () => {
    const increment = jest.fn()
    const { guard } = build(increment)
    await expect(guard.canActivate(contextOf(handlerOf('free'), { id: 'u1' }))).resolves.toBe(true)
    expect(increment).not.toHaveBeenCalled()
  })

  it('fails loudly, never open, when the route was reached with no user', async () => {
    const increment = jest.fn()
    const { guard } = build(increment)
    await expect(guard.canActivate(contextOf(limited, undefined))).rejects.toMatchObject({
      statusCode: HttpStatusCodes.INTERNAL_SERVER_ERROR
    })
    expect(increment).not.toHaveBeenCalled()
  })
})
