import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import { FiscalRuntimeModule } from '@platform/fiscal/runtime'

import { MediaModule } from '../media/media.module'
import { TenancyModule } from '../tenancy'

import { CustomerFiscalDataController } from './customer-fiscal-data.controller'
import { FiscalEvidenceUrlsService } from './fiscal-evidence-urls.service'
import { FiscalSubmissionQueue } from './fiscal-submission.queue'
import { FiscalController } from './fiscal.controller'
import { FiscalListener } from './fiscal.listener'

// The routes of the fiscal documents of the organization and the listener that makes the document of a sale. The lifecycle and the
// providers are `libs/fiscal/runtime`, which the worker also runs.
@Module({
  imports: [FiscalRuntimeModule, MediaModule, QueuesPlatformModule, TenancyModule],
  controllers: [FiscalController, CustomerFiscalDataController],
  providers: [FiscalEvidenceUrlsService, FiscalSubmissionQueue, FiscalListener]
})
export class FiscalModule {}
