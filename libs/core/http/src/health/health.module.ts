import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'

import { HealthController } from './health.controller'
import { PrismaHealthIndicator } from './prisma-health.indicator'
import { RedisHealthIndicator } from './redis-health.indicator'
import { StorageHealthIndicator } from './storage-health.indicator'

// Needs the database, Redis and storage modules of the service (all global)
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator, RedisHealthIndicator, StorageHealthIndicator]
})
export class HealthModule {}
