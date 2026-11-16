import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import { FiscalRuntimeModule } from '@platform/fiscal/runtime'

import { TenancyModule } from '../tenancy'

import { FiscalSubmissionQueue } from './fiscal-submission.queue'
import { FiscalController } from './fiscal.controller'
import { FiscalListener } from './fiscal.listener'

// The routes of the fiscal documents of the organization and the listener that makes the document of a sale. The lifecycle and the
// providers are `libs/fiscal/runtime`, which the worker also runs.
@Module({
  imports: [FiscalRuntimeModule, QueuesPlatformModule, TenancyModule],
  controllers: [FiscalController],
  providers: [FiscalSubmissionQueue, FiscalListener]
})
export class FiscalModule {}
