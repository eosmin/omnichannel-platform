import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query
} from '@nestjs/common'

import {
  type CreateReportBody,
  createReportSchema,
  type UpdateReportBody,
  updateReportSchema
} from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import { ExportTypes } from '@platform/core/queues'

import { ExportsService, type ExportView } from '../exports'
import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { MetricsQueryService, type MetricsResult } from './metrics-query.service'
import { type MetricsQuery, metricsQuerySchema } from './metrics.schemas'
import { type MyPerformance, MyPerformanceService } from './my-performance.service'
import { type AnalyticsExportQuery, analyticsExportQuerySchema } from './reports.schemas'
import { ReportsService, type ReportView } from './reports.service'

// The analytics of the store in X-Store-Id (TDD_11 §7). The store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class AnalyticsController {
  constructor(
    private readonly metrics: MetricsQueryService,
    private readonly myPerformance: MyPerformanceService,
    private readonly reports: ReportsService,
    private readonly exports: ExportsService
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

  // The figures of the dashboard as a file, made in the background: the answer is the export to follow in the exports center.
  // Declared before nothing with a path parameter, so "export" is never read as an id.
  @RequirePermissions(Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_EXPORT)
  @Get(ApiRoutes.analytics.export)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  requestExport(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(analyticsExportQuerySchema)) query: AnalyticsExportQuery
  ): Promise<ExportView> {
    return this.exports.request({
      storeId: store.id,
      userId: user.id,
      type: ExportTypes.ANALYTICS,
      format: query.format,
      filters: query.filters
    })
  }

  // Scheduled reports: each one sends the figures of the store out by email, so the person who saves one needs the right to take
  // them out as well as the right to manage reports
  @RequirePermissions(Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_MANAGE_REPORTS)
  @Get(ApiRoutes.analytics.reports)
  listReports(@CurrentStore() store: ResolvedTenant['store']): Promise<ReportView[]> {
    return this.reports.list(store.id)
  }

  @RequirePermissions(
    Permissions.ANALYTICS_VIEW,
    Permissions.ANALYTICS_EXPORT,
    Permissions.ANALYTICS_MANAGE_REPORTS
  )
  @Post(ApiRoutes.analytics.reports)
  @HttpCode(HttpStatusCodes.CREATED)
  createReport(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createReportSchema)) body: CreateReportBody
  ): Promise<ReportView> {
    return this.reports.create(store.id, user.id, body)
  }

  @RequirePermissions(
    Permissions.ANALYTICS_VIEW,
    Permissions.ANALYTICS_EXPORT,
    Permissions.ANALYTICS_MANAGE_REPORTS
  )
  @Patch(ApiRoutes.analytics.reportById(':id'))
  updateReport(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateReportSchema)) body: UpdateReportBody
  ): Promise<ReportView> {
    return this.reports.update(store.id, user.id, id, body)
  }

  @RequirePermissions(Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_MANAGE_REPORTS)
  @Delete(ApiRoutes.analytics.reportById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeReport(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string
  ): Promise<void> {
    await this.reports.remove(store.id, user.id, id)
  }
}
