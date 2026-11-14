import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { AnalyticsController } from './analytics.controller'
import { MetricsQueryService } from './metrics-query.service'
import { MyPerformanceService } from './my-performance.service'

// The metrics of the dashboard (TDD_11 §7.3). The database is the app's module.
@Module({
  imports: [TenancyModule],
  controllers: [AnalyticsController],
  providers: [MetricsQueryService, MyPerformanceService]
})
export class AnalyticsModule {}
