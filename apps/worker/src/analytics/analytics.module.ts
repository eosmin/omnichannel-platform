import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { AnalyticsProcessor } from '../processors/analytics.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { AnalyticsEventWriter } from './analytics-event.writer'

// The database and the logger come from the platform module of the worker
@Module({
  imports: [QueuesPlatformModule],
  providers: [ProcessorSupport, AnalyticsEventWriter, AnalyticsProcessor]
})
export class AnalyticsModule {}
