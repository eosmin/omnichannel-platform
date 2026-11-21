import type { ExecutionContext } from '@nestjs/common'

import {
  authenticatedUserRateLimitOf,
  AuthenticatedUserRateLimit,
  type UserRateLimitProfile
} from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { AuthenticatedUserRateLimitGuard } from './authenticated-user-rate-limit.guard'

const contextOf = (request: { user?: { id: string } }, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request })
  }) as unknown as ExecutionContext

const record = (isBlocked: boolean, wait = 0) => ({
  totalHits: 1,
  timeToExpire: 30,
  isBlocked,
  timeToBlockExpire: wait
})

function build(increment: jest.Mock, profile: UserRateLimitProfile = AuthenticatedUserRateLimit) {
  const inc = jest.fn()
  const observe = jest.fn()
  const guard = new AuthenticatedUserRateLimitGuard(
    { increment },
    { inc } as never,
    { observe } as never,
    profile
  )
  return { guard, inc, observe }
}

describe('AuthenticatedUserRateLimitGuard', () => {
  it('counts the user in the authenticated counter, with the limit of the profile', async () => {
    const increment = jest.fn().mockResolvedValue(record(false))
    const { guard } = build(increment)
    await expect(guard.canActivate(contextOf({ user: { id: 'u1' } }))).resolves.toBe(true)
    expect(increment).toHaveBeenCalledWith(
      'u1',
      AuthenticatedUserRateLimit.ttlMs,
      AuthenticatedUserRateLimit.limit,
      0,
      'user:authenticated'
    )
  })

  it('counts with the budget in force when the test environment raised it, and with the real one otherwise', async () => {
    expect(authenticatedUserRateLimitOf(undefined)).toBe(AuthenticatedUserRateLimit)
    const increment = jest.fn().mockResolvedValue(record(false))
    const { guard } = build(increment, authenticatedUserRateLimitOf(100_000))
    await guard.canActivate(contextOf({ user: { id: 'u1' } }))
    expect(increment).toHaveBeenCalledWith(
      'u1',
      expect.anything(),
      100_000,
      0,
      'user:authenticated'
    )
  })

  it('refuses a user past the budget with a 429 that says when to come back, and counts the refusal', async () => {
    const { guard, inc } = build(jest.fn().mockResolvedValue(record(true, 21)))
    const refusal: unknown = await guard
      .canActivate(contextOf({ user: { id: 'u1' } }))
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(PlatformException)
    expect(refusal).toMatchObject({
      code: ErrorCodes.RATE_LIMIT_EXCEEDED,
      statusCode: HttpStatusCodes.TOO_MANY_REQUESTS,
      metadata: { retryAfterSeconds: 21 }
    })
    expect(inc).toHaveBeenCalledWith({ throttler: 'user:authenticated' })
  })

  it('records how much of the budget was spent, by throttler and never by person', async () => {
    const increment = jest.fn().mockResolvedValue({ ...record(false), totalHits: 150 })
    const { guard, observe } = build(increment)
    await guard.canActivate(contextOf({ user: { id: 'u1' } }))
    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(
      { throttler: 'user:authenticated' },
      150 / AuthenticatedUserRateLimit.limit
    )
  })

  it('does not count a route with no authenticated user (public, probes, plugin api)', async () => {
    const increment = jest.fn()
    const { guard } = build(increment)
    await expect(guard.canActivate(contextOf({}))).resolves.toBe(true)
    expect(increment).not.toHaveBeenCalled()
  })

  it('does not count a websocket message, even when the socket carries a user', async () => {
    const increment = jest.fn()
    const { guard } = build(increment)
    await expect(guard.canActivate(contextOf({ user: { id: 'u1' } }, 'ws'))).resolves.toBe(true)
    expect(increment).not.toHaveBeenCalled()
  })

  it('lets the request through, and logs, when the storage fails', async () => {
    const { guard } = build(jest.fn().mockRejectedValue(new Error('redis down')))
    await expect(guard.canActivate(contextOf({ user: { id: 'u1' } }))).resolves.toBe(true)
  })
})
