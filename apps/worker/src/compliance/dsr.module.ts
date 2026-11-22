import { Module } from '@nestjs/common'

import { CustomerErasureService, DsrOpenWorkService } from '@platform/core/customer-erasure'
import {
  CompliancePlatformModule,
  DigestPlatformModule,
  QueuesPlatformModule
} from '@platform/core/http'

import { DsrEraseDueSweeper } from './dsr-erase-due.sweeper'
import { DsrExpireSweeper } from './dsr-expire.sweeper'
import { DsrIntakeWorker } from './dsr-intake.worker'

// The public data request flow, worker side (Step 7.2-H1): the intake of a request and the sweep that closes the ones never confirmed. The database, the logger and the audit come from the platform modules of the worker.
@Module({
  imports: [QueuesPlatformModule, DigestPlatformModule, CompliancePlatformModule],
  providers: [
    DsrIntakeWorker,
    DsrExpireSweeper,
    DsrEraseDueSweeper,
    CustomerErasureService,
    DsrOpenWorkService
  ],
  exports: [DsrIntakeWorker, DsrExpireSweeper, DsrEraseDueSweeper]
})
export class DsrWorkerModule {}
