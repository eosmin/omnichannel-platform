import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import { OutboundQueue } from '@platform/core/messaging'
import { FiscalRuntimeModule } from '@platform/fiscal/runtime'

import { ChannelRegistryModule } from '../channel-registry'
import { ConversationsModule } from '../conversations'
import { MediaModule } from '../media/media.module'
import { OrderMessagesModule } from '../order-messages/order-messages.module'
import { TenancyModule } from '../tenancy'

import { CustomerFiscalDataController } from './customer-fiscal-data.controller'
import { FiscalAnnexExportService } from './fiscal-annex-export.service'
import { FiscalAnnexController } from './fiscal-annex.controller'
import { FiscalContingencyController } from './fiscal-contingency.controller'
import { FiscalDeliveryListener } from './fiscal-delivery.listener'
import { FiscalDeliveryService } from './fiscal-delivery.service'
import { FiscalEvidenceUrlsService } from './fiscal-evidence-urls.service'
import { FiscalHandDeliveryService } from './fiscal-hand-delivery.service'
import { FiscalReachService } from './fiscal-reach.service'
import { FiscalSubmissionQueue } from './fiscal-submission.queue'
import { FiscalController } from './fiscal.controller'
import { FiscalListener } from './fiscal.listener'

// The routes of the fiscal documents of the organization and the listener that makes the document of a sale. The lifecycle and the
// providers are `libs/fiscal/runtime`, which the worker also runs.
@Module({
  imports: [
    ChannelRegistryModule,
    ConversationsModule,
    FiscalRuntimeModule,
    MediaModule,
    OrderMessagesModule,
    QueuesPlatformModule,
    TenancyModule
  ],
  controllers: [
    FiscalController,
    FiscalAnnexController,
    FiscalContingencyController,
    CustomerFiscalDataController
  ],
  providers: [
    FiscalAnnexExportService,
    FiscalDeliveryListener,
    FiscalDeliveryService,
    FiscalEvidenceUrlsService,
    FiscalHandDeliveryService,
    FiscalListener,
    FiscalReachService,
    FiscalSubmissionQueue,
    OutboundQueue
  ]
})
export class FiscalModule {}
