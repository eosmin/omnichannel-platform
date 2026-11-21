import type { Logger } from '@nestjs/common'

import { AuthenticatedUserRateLimit, userRateLimitThrottler } from '@platform/core/auth'
import { ErrorCodes } from '@platform/core/errors'

import { spendUserBudget } from './spend-user-budget'

const throttler = userRateLimitThrottler(AuthenticatedUserRateLimit)
const record = (totalHits: number, isBlocked = false) => ({
  totalHits,
  timeToExpire: 30,
  isBlocked,
  timeToBlockExpire: isBlocked ? 12 : 0
})

function run(increment: jest.Mock, userId = 'u1') {
  const hits = { inc: jest.fn() }
  const usage = { observe: jest.fn() }
  const logger = { error: jest.fn() } as unknown as Logger
  const spent = spendUserBudget(
    { increment },
    hits as never,
    usage as never,
    logger,
    userId,
    AuthenticatedUserRateLimit
  )
  return { spent, hits, usage }
}

describe('spendUserBudget metrics', () => {
  it('observes the share spent with the throttler as the only label, never the user id', async () => {
    const { spent, hits, usage } = run(jest.fn().mockResolvedValue(record(300)))
    await spent
    expect(usage.observe).toHaveBeenCalledWith(
      { throttler },
      300 / AuthenticatedUserRateLimit.limit
    )
    expect(JSON.stringify(usage.observe.mock.calls)).not.toContain('u1')
    expect(hits.inc).not.toHaveBeenCalled()
  })

  it('observes at most 1 and counts the refusal by throttler when the budget is past', async () => {
    const { spent, hits, usage } = run(
      jest.fn().mockResolvedValue(record(AuthenticatedUserRateLimit.limit + 40, true))
    )
    await expect(spent).rejects.toMatchObject({ code: ErrorCodes.RATE_LIMIT_EXCEEDED })
    expect(usage.observe).toHaveBeenCalledWith({ throttler }, 1)
    expect(hits.inc).toHaveBeenCalledWith({ throttler })
    expect(JSON.stringify(hits.inc.mock.calls)).not.toContain('u1')
  })

  it('observes nothing when the storage fails (the request goes on)', async () => {
    const { spent, hits, usage } = run(jest.fn().mockRejectedValue(new Error('redis down')))
    await expect(spent).resolves.toBeUndefined()
    expect(usage.observe).not.toHaveBeenCalled()
    expect(hits.inc).not.toHaveBeenCalled()
  })
})
