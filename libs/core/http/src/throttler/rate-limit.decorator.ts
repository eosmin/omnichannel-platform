import { Throttle } from '@nestjs/throttler'

import { ThrottlerNames } from '@platform/core/auth'

export interface RateLimitProfile {
  limit: number
  ttlMs: number
}

// @RateLimit(ThrottleProfiles.PUBLIC) or @RateLimit(MagicLinkThrottle): the limit of one route, per
// client IP, instead of the default profile
export const RateLimit = (profile: RateLimitProfile): MethodDecorator & ClassDecorator =>
  Throttle({ [ThrottlerNames.DEFAULT]: { limit: profile.limit, ttl: profile.ttlMs } })
