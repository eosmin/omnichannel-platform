import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { DatabaseModule } from '@platform/core/database'
import { EventBusModule } from '@platform/core/event-bus'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'
import { RedisModule } from '@platform/core/redis'

import { AuthPlatformModule } from './auth-platform.module'
import { HealthModule } from './health/health.module'
import { HttpErrorsModule } from './http-errors.module'
import { ThrottlerPlatformModule } from './throttler'

// What every HTTP service of the platform (api and worker) is made of, configured from the validated
// env: logging, metrics, the database, the event bus, Redis, the rate limit, the access tokens, the
// error contract and the health routes. The apps never read the env themselves.
@Module({
  imports: [
    LoggerModule.forRoot({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
    MetricsModule,
    DatabaseModule.forRoot({ databaseUrl: env.DATABASE_URL, replicaUrl: env.DATABASE_REPLICA_URL }),
    EventBusModule,
    RedisModule.forRoot({ url: env.REDIS_URL }),
    ThrottlerPlatformModule, // Before the auth module: the rate limit is checked first
    AuthPlatformModule,
    HttpErrorsModule,
    HealthModule
  ]
})
export class HttpPlatformModule {}
