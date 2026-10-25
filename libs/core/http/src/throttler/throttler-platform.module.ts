import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import type { Redis } from 'ioredis'

import { ThrottlerNames, ThrottleProfiles } from '@platform/core/auth'
import { REDIS_CLIENT, RedisThrottlerStorage } from '@platform/core/redis'

import { ResilientThrottlerGuard } from './resilient-throttler.guard'

// The rate limit of every route: the default profile, counted per client IP in Redis so that it holds
// across replicas. A route asks for another profile with @RateLimit(), and the probes opt out.
// Import it before the auth module: the guards run in the order they were registered, and a flood
// should be refused before it reaches the token check.
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
  providers: [{ provide: APP_GUARD, useClass: ResilientThrottlerGuard }]
})
export class ThrottlerPlatformModule {}
