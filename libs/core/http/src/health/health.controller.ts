import { Controller, Get, Inject, Optional } from '@nestjs/common'
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'

import { InfraRoutes } from '@platform/core/api'
import { Public } from '@platform/core/auth-module'

import { PrismaHealthIndicator } from './prisma-health.indicator'
import { READINESS_CHECKS, type ReadinessCheck } from './readiness-checks'
import { RedisHealthIndicator } from './redis-health.indicator'
import { StorageHealthIndicator } from './storage-health.indicator'

// Outside the /api/v1 prefix so that probes and load balancers hit /health and /health/ready.
// Public: a probe carries no token. Not rate limited: the platform probes every few seconds.
@Public()
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly storage: StorageHealthIndicator,
    @Optional() @Inject(READINESS_CHECKS) private readonly extraChecks: ReadinessCheck[] = []
  ) {}

  // Liveness: is the process alive? It never touches a dependency.
  @Get(InfraRoutes.healthLive)
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([() => Promise.resolve({ process: { status: 'up' } })])
  }

  // Readiness: can it serve traffic? Only the dependencies a request needs, and only those: a queue
  // backlog must scale workers, not take API instances out of the load balancer. Storage is one: a
  // signed upload URL or a download is useless when the bucket cannot be reached.
  @Get(InfraRoutes.healthReady)
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.isHealthy('database', { timeoutMs: 3000 }),
      () => this.redis.isHealthy('redis', { timeoutMs: 2000 }),
      () => this.storage.isHealthy('storage', { timeoutMs: 2000 }),
      ...this.extraChecks
    ])
  }
}
