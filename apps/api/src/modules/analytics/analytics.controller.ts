import { Controller, Get, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'

import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { MetricsQueryService, type MetricsResult } from './metrics-query.service'
import { type MetricsQuery, metricsQuerySchema } from './metrics.schemas'

// The analytics of the store in X-Store-Id (TDD_11 §7). The store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class AnalyticsController {
  constructor(private readonly metrics: MetricsQueryService) {}

  @RequirePermissions(Permissions.ANALYTICS_VIEW)
  @Get(ApiRoutes.analytics.metrics)
  metricsOf(
    @CurrentStore() store: ResolvedTenant['store'],
    @Query(new ZodValidationPipe(metricsQuerySchema)) query: MetricsQuery
  ): Promise<MetricsResult> {
    return this.metrics.query(store.id, query)
  }
}
