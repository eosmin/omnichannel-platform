import { Controller, Get, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { ZodValidationPipe } from '@platform/core/http'

import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { MetricsQueryService, type MetricsResult } from './metrics-query.service'
import { type MetricsQuery, metricsQuerySchema } from './metrics.schemas'
import { type MyPerformance, MyPerformanceService } from './my-performance.service'

// The analytics of the store in X-Store-Id (TDD_11 §7). The store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class AnalyticsController {
  constructor(
    private readonly metrics: MetricsQueryService,
    private readonly myPerformance: MyPerformanceService
  ) {}

  @RequirePermissions(Permissions.ANALYTICS_VIEW)
  @Get(ApiRoutes.analytics.metrics)
  metricsOf(
    @CurrentStore() store: ResolvedTenant['store'],
    @Query(new ZodValidationPipe(metricsQuerySchema)) query: MetricsQuery
  ): Promise<MetricsResult> {
    return this.metrics.query(store.id, query)
  }

  // The figures of the person who asks, for the widget of the inbox: an agent has no analytics:view, and sees only their own
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.analytics.myPerformance)
  myPerformanceOf(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser
  ): Promise<MyPerformance> {
    return this.myPerformance.of(store.id, user.id)
  }
}
