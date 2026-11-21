import type { ExecutionContext } from '@nestjs/common'

import { AuthenticatedUserRateLimit } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { AuthenticatedUserRateLimitGuard } from './authenticated-user-rate-limit.guard'

const contextOf = (request: { user?: { id: string } }): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext

const record = (isBlocked: boolean, wait = 0) => ({
  totalHits: 1,
  timeToExpire: 30,
  isBlocked,
  timeToBlockExpire: wait
})

function build(increment: jest.Mock) {
  const inc = jest.fn()
  const guard = new AuthenticatedUserRateLimitGuard({ increment }, { inc } as never)
  return { guard, inc }
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

  it('does not count a route with no authenticated user (public, probes, plugin api)', async () => {
    const increment = jest.fn()
    const { guard } = build(increment)
    await expect(guard.canActivate(contextOf({}))).resolves.toBe(true)
    expect(increment).not.toHaveBeenCalled()
  })

  it('lets the request through, and logs, when the storage fails', async () => {
    const { guard } = build(jest.fn().mockRejectedValue(new Error('redis down')))
    await expect(guard.canActivate(contextOf({ user: { id: 'u1' } }))).resolves.toBe(true)
  })
})
