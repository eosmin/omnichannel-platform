import { Global, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import type { Redis } from 'ioredis'

import { ThrottlerNames, ThrottleProfiles } from '@platform/core/auth'
import { REDIS_CLIENT, RedisThrottlerStorage } from '@platform/core/redis'

import { AuthenticatedUserRateLimitGuard } from './authenticated-user-rate-limit.guard'
import { ResilientThrottlerGuard } from './resilient-throttler.guard'
import { USER_RATE_LIMIT_STORAGE, UserRateLimitGuard } from './user-rate-limit.guard'

// The rate limit of every route: the default profile, counted per client IP in Redis so that it holds
// across replicas. A route asks for another profile with @RateLimit(), and the probes opt out.
// Import it before the auth module: the guards run in the order they were registered, and a flood
// should be refused before it reaches the token check.
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        throttlers: [
          {
            name: ThrottlerNames.DEFAULT,
            ttl: ThrottleProfiles.DEFAULT.ttlMs,
            limit: ThrottleProfiles.DEFAULT.limit
          }
        ],
        storage: new RedisThrottlerStorage(redis)
      })
    })
  ],
  providers: [
    { provide: APP_GUARD, useClass: ResilientThrottlerGuard },
    // The second layer of the routes that can enumerate data (@UserRateLimit, TDD_05 §3.1) counts in the same Redis. Global,
    // because a guard named in @UseGuards is built in the module of the controller that names it.
    {
      provide: USER_RATE_LIMIT_STORAGE,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => new RedisThrottlerStorage(redis)
    },
    UserRateLimitGuard,
    // Not an APP_GUARD here: it needs the user, so TenancyModule registers it after the guards of the token and the permission
    AuthenticatedUserRateLimitGuard
  ],
  exports: [USER_RATE_LIMIT_STORAGE, UserRateLimitGuard, AuthenticatedUserRateLimitGuard]
})
export class ThrottlerPlatformModule {}
