import { Global, Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { TerminusModule } from '@nestjs/terminus'

import { READINESS_CHECKS, type ReadinessCheck } from '@platform/core/http'

import { BullWorkersIndicator } from './bull-workers.indicator'

// Global so that the shared HealthController, built in HttpPlatformModule, finds the check
@Global()
@Module({
  imports: [DiscoveryModule, TerminusModule], // TerminusModule is not global: it exports HealthIndicatorService
  providers: [
    BullWorkersIndicator,
    {
      provide: READINESS_CHECKS,
      inject: [BullWorkersIndicator],
      useFactory: (workers: BullWorkersIndicator): ReadinessCheck[] => [
        () => Promise.resolve(workers.isHealthy('bullmq'))
      ]
    }
  ],
  exports: [READINESS_CHECKS]
})
export class WorkerReadinessModule {}
