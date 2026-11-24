import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'
import { Registry } from '@prometheus-io/client'

import { InfraRoutes } from '@platform/core/api'
import { Public } from '@platform/core/auth-module'

import { METRICS_REGISTRY } from './metric-tokens'
import { bearerMatches, METRICS_ACCESS, type MetricsAccess } from './metrics-access'

// /metrics is outside the /api/v1 prefix. It is `@Public()` for the session guard (a scraper holds no session) and guarded here instead: a
// deployed environment answers it only to the bearer token of `METRICS_BEARER_TOKEN`, and with none set the route is a 404 (B5). The network
// still keeps it off the public edge (Step 7.5); this is the second lock, not a replacement for it.
@Public()
@SkipThrottle()
@Controller()
export class MetricsController {
  constructor(
    @Inject(METRICS_REGISTRY) private readonly registry: Registry,
    // Required: a module that forgets `MetricsModule.forRoot(...)` fails to start instead of serving the figures to anyone
    @Inject(METRICS_ACCESS) private readonly access: MetricsAccess
  ) {}

  @Get(InfraRoutes.metrics)
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(@Headers('authorization') authorization?: string): Promise<string> {
    if (this.access.mode === 'closed') throw new NotFoundException()
    if (this.access.mode === 'token' && !bearerMatches(authorization, this.access.token)) {
      throw new UnauthorizedException()
    }
    return this.registry.metrics()
  }
}
