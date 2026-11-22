import { Module } from '@nestjs/common'

import {
  CompliancePlatformModule,
  DigestPlatformModule,
  QueuesPlatformModule
} from '@platform/core/http'

import { DsrIntakeWorker } from './dsr-intake.worker'

// The public data request flow, worker side (Step 7.2-H1). The database, the logger and the audit come from the platform modules of the worker.
@Module({
  imports: [QueuesPlatformModule, DigestPlatformModule, CompliancePlatformModule],
  providers: [DsrIntakeWorker],
  exports: [DsrIntakeWorker]
})
export class DsrWorkerModule {}
