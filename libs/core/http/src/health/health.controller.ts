import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus'

import { InfraRoutes } from '@platform/core/api'

import { PrismaHealthIndicator } from './prisma-health.indicator'

// Outside the /api/v1 prefix so that probes and load balancers hit /health and /health/ready.
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator
  ) {}

  // Liveness: is the process alive? It never touches a dependency.
  @Get(InfraRoutes.healthLive)
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([() => Promise.resolve({ process: { status: 'up' } })])
  }

  // Readiness: can it serve traffic? Only the dependencies a request needs, and only those: a queue
  // backlog must scale workers, not take API instances out of the load balancer. Redis and storage
  // join when their clients exist (Step 1.0 and the storage step).
  @Get(InfraRoutes.healthReady)
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.database.isHealthy('database', { timeoutMs: 3000 })])
  }
}
