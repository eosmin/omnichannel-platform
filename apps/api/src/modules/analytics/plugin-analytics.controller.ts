import { Controller, Get, HttpCode, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import { ExportTypes } from '@platform/core/queues'
import { PluginScopes } from '@platform/plugins/sdk'

import { ExportsService, type ExportView } from '../exports'
import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'
import { pluginUserId } from '../tenancy/actor'

import { MetricsQueryService, type MetricsResult } from './metrics-query.service'
import { type MetricsQuery, pluginMetricsQuerySchema } from './metrics.schemas'
import { type AnalyticsExportQuery, analyticsExportQuerySchema } from './reports.schemas'

// The figures of the store of the key (Step 5.6 PR E7), over the same services as the screen. The store is the one of the key, never a
// value of the request. Not here, on purpose: the scheduled reports (each one sends the figures out by email to addresses of people: PR
// E7-2), what was searched (the report of the searches of people) and the figures of one person (`my-performance`); nor the breakdown by agent of the
// metrics, which names the members of the team.
@Controller()
export class PluginAnalyticsController {
  constructor(
    private readonly metrics: MetricsQueryService,
    private readonly exports: ExportsService
  ) {}

  @PluginApi(PluginScopes.ANALYTICS_READ)
  @RequirePermissions(Permissions.ANALYTICS_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.analytics.metrics)
  metricsOf(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(pluginMetricsQuerySchema)) query: MetricsQuery
  ): Promise<MetricsResult> {
    return this.metrics.query(store.id, query)
  }

  // The figures as a file, made in the background with the retention, the ceiling of active exports and the signed link of the exports of a
  // person; the answer is the export to follow at `GET /plugin-api/exports/:id`. Both scopes, as a person needs the right to see the figures
  // and the right to take them out.
  @PluginApi(PluginScopes.ANALYTICS_READ, PluginScopes.EXPORTS_WRITE)
  @RequirePermissions(Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_EXPORT)
  @NoStore()
  @Get(PluginApiRoutes.analytics.export)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  requestExport(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string },
    @Query(new ZodValidationPipe(analyticsExportQuerySchema)) query: AnalyticsExportQuery
  ): Promise<ExportView> {
    return this.exports.request({
      storeId: store.id,
      userId: pluginUserId(installation.id),
      type: ExportTypes.ANALYTICS,
      format: query.format,
      filters: query.filters
    })
  }
}
