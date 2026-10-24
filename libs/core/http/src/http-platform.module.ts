import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { DatabaseModule } from '@platform/core/database'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { HealthModule } from './health/health.module'
import { HttpErrorsModule } from './http-errors.module'

// What every HTTP service of the platform (api and worker) is made of, configured from the
// validated env: logging, metrics, the database, the error contract and the health routes. The
// apps never read the env themselves.
@Module({
  imports: [
    LoggerModule.forRoot({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }),
    MetricsModule,
    DatabaseModule.forRoot({ databaseUrl: env.DATABASE_URL, replicaUrl: env.DATABASE_REPLICA_URL }),
    HttpErrorsModule,
    HealthModule
  ]
})
export class HttpPlatformModule {}
