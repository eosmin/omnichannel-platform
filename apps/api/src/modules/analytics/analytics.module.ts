import { Module } from '@nestjs/common'

import { ExportsModule } from '../exports'
import { TenancyModule } from '../tenancy'

import { AnalyticsController } from './analytics.controller'
import { MetricsQueryService } from './metrics-query.service'
import { MyPerformanceService } from './my-performance.service'
import { ReportsService } from './reports.service'

// The metrics of the dashboard (TDD_11 §7.3). The database is the app's module.
@Module({
  imports: [ExportsModule, TenancyModule],
  controllers: [AnalyticsController],
  providers: [MetricsQueryService, MyPerformanceService, ReportsService]
})
export class AnalyticsModule {}
