import { Module } from '@nestjs/common'

import { AppRoles } from '@platform/core/config'
import { env } from '@platform/core/config/env'
import { DatabaseModule } from '@platform/core/database'
import { EventBusModule, EventsBridgeModes } from '@platform/core/event-bus'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'
import { RedisModule } from '@platform/core/redis'

import { AuthPlatformModule } from './auth-platform.module'
import { HealthModule } from './health/health.module'
import { HttpErrorsModule } from './http-errors.module'
import { StoragePlatformModule } from './storage-platform.module'
import { ThrottlerPlatformModule } from './throttler'
import { TrustProxyModule } from './trust-proxy.module'

// One entry per role, so that a role added later has to say what it does with the bridge
const BRIDGE_MODES = {
  [AppRoles.API]: EventsBridgeModes.SUBSCRIBE,
  [AppRoles.WORKER]: EventsBridgeModes.PUBLISH
} as const

// What every HTTP service of the platform (api and worker) is made of, configured from the validated
// env: logging, metrics, the database, the event bus, Redis, object storage, the rate limit, the access tokens, the
// error contract and the health routes. The apps never read the env themselves.
@Module({
  imports: [
    LoggerModule.forRoot({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
    MetricsModule,
    DatabaseModule.forRoot({ databaseUrl: env.DATABASE_URL, replicaUrl: env.DATABASE_REPLICA_URL }),
    // The worker has no sockets: what it announces goes to the api instances through Redis
    EventBusModule.forRoot({ mode: BRIDGE_MODES[env.APP_ROLE] }),
    RedisModule.forRoot({ url: env.REDIS_URL }),
    StoragePlatformModule,
    ThrottlerPlatformModule, // Before the auth module: the rate limit is checked first
    AuthPlatformModule,
    TrustProxyModule,
    HttpErrorsModule,
    HealthModule
  ]
})
export class HttpPlatformModule {}
