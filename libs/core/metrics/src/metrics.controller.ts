import { Controller, Get, Header, Inject } from '@nestjs/common'
import { Registry } from '@prometheus-io/client'

import { InfraRoutes } from '@platform/core/api'

import { METRICS_REGISTRY } from './metric-tokens'

// /metrics is outside the /api/v1 prefix and reachable only from the internal network: it is never
// exposed through the public edge.
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get(InfraRoutes.metrics)
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.registry.metrics()
  }
}
