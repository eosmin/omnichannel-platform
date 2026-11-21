import type { Logger } from '@nestjs/common'
import type { ThrottlerStorage } from '@nestjs/throttler'
import type { Counter } from '@prometheus-io/client'

import {
  RETRY_AFTER_METADATA_KEY,
  type UserRateLimitProfile,
  userRateLimitThrottler
} from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// Spends one request of the budget of a user in the counter of the profile. The per-user layers are a protection and not a
// dependency: when Redis fails the request goes on and the failure is logged. What is refused is answered 429 with the time to
// wait, and counted in the metric of the throttler.
export async function spendUserBudget(
  storage: ThrottlerStorage,
  hits: Counter<string>,
  logger: Logger,
  userId: string,
  profile: UserRateLimitProfile
): Promise<void> {
  let record: Awaited<ReturnType<ThrottlerStorage['increment']>>
  try {
    record = await storage.increment(
      userId,
      profile.ttlMs,
      profile.limit,
      0,
      userRateLimitThrottler(profile)
    )
  } catch (error) {
    logger.error(
      `per-user rate limit storage failed, letting the request through: ${error instanceof Error ? error.message : 'unknown error'}`
    )
    return
  }
  if (!record.isBlocked) return
  hits.inc({ throttler: userRateLimitThrottler(profile) })
  throw new PlatformException(
    ErrorCodes.RATE_LIMIT_EXCEEDED,
    'Too many requests',
    HttpStatusCodes.TOO_MANY_REQUESTS,
    { [RETRY_AFTER_METADATA_KEY]: Math.max(record.timeToBlockExpire, 1) }
  )
}
