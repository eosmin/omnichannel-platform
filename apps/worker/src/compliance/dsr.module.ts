import { Module } from '@nestjs/common'

import { CustomerErasureService, DsrOpenWorkService } from '@platform/core/customer-erasure'
import {
  CompliancePlatformModule,
  CryptoPlatformModule,
  DigestPlatformModule,
  QueuesPlatformModule
} from '@platform/core/http'

import { DsrDeadlineChecker } from './dsr-deadline.checker'
import { DsrEraseDueSweeper } from './dsr-erase-due.sweeper'
import { DsrExpireSweeper } from './dsr-expire.sweeper'
import { DsrExportRunner } from './dsr-export.runner'
import { DsrIntakeWorker } from './dsr-intake.worker'
import { DsrNoticeLedger } from './dsr-notice-ledger.service'
import { DsrNoticeSender } from './dsr-notice-sender.service'

// The public data request flow, worker side (Step 7.2-H1): the intake of a request and the sweep that closes the ones never confirmed. The database, the logger and the audit come from the platform modules of the worker.
@Module({
  imports: [
    QueuesPlatformModule,
    DigestPlatformModule,
    CompliancePlatformModule,
    CryptoPlatformModule
  ],
  providers: [
    DsrIntakeWorker,
    DsrExpireSweeper,
    DsrEraseDueSweeper,
    CustomerErasureService,
    DsrOpenWorkService,
    DsrNoticeLedger,
    DsrNoticeSender,
    DsrExportRunner,
    DsrDeadlineChecker
  ],
  exports: [
    DsrIntakeWorker,
    DsrExpireSweeper,
    DsrEraseDueSweeper,
    DsrNoticeLedger,
    DsrNoticeSender,
    DsrExportRunner,
    DsrDeadlineChecker
  ]
})
export class DsrWorkerModule {}
