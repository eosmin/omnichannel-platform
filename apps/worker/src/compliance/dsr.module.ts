import { Module } from '@nestjs/common'

import {
  CompliancePlatformModule,
  DigestPlatformModule,
  QueuesPlatformModule
} from '@platform/core/http'

import { DsrExpireSweeper } from './dsr-expire.sweeper'
import { DsrIntakeWorker } from './dsr-intake.worker'

// The public data request flow, worker side (Step 7.2-H1): the intake of a request and the sweep that closes the ones never confirmed. The database, the logger and the audit come from the platform modules of the worker.
@Module({
  imports: [QueuesPlatformModule, DigestPlatformModule, CompliancePlatformModule],
  providers: [DsrIntakeWorker, DsrExpireSweeper],
  exports: [DsrIntakeWorker, DsrExpireSweeper]
})
export class DsrWorkerModule {}
