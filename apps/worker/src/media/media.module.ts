import { Module } from '@nestjs/common'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import {
  CLAMAV_ADDRESS,
  type ClamavAddress,
  QueuesPlatformModule,
  VirusScanPlatformModule
} from '@platform/core/http'
import { FiscalRuntimeModule } from '@platform/fiscal/runtime'
import { PluginsModule } from '@platform/plugins/runtime'

import { CarriersWorkerModule } from '../carriers/carriers.module'
import { DsrWorkerModule } from '../compliance/dsr.module'
import { FinancePostingWorkerModule } from '../finance/finance-posting.module'
import { InventoryReconcileModule } from '../inventory/inventory.module'
import { HeavyProcessingProcessor } from '../processors/heavy-processing.processor'
import { ProcessorSupport } from '../processors/processor-support'
import { RetentionWorkerModule } from '../retention/retention.module'
import { ShippingWorkerModule } from '../shipping/shipping.module'

import { ClamavClient } from './clamav.client'
import { ExistingDocumentSanitizer } from './existing-document-sanitizer.service'
import { ExistingPictureSanitizer } from './existing-picture-sanitizer.service'
import { InboundMediaFetcher } from './inbound-media-fetcher.service'
import { MediaPipeline } from './media-pipeline.service'
import { OriginMediaFetcher } from './origin-media-fetcher.service'
import { OrphanMediaCleaner } from './orphan-media-cleaner.service'
import { UnavailableFileMarker } from './unavailable-file-marker.service'
import { VersionedBucketGuard } from './versioned-bucket.guard'

// The storage, the database and the logger come from the platform module of the worker; the queue of
// the heavy jobs from QueuesPlatformModule; the address of ClamAV from VirusScanPlatformModule.
// Also exports the cleaner: the scheduler of the worker module runs it.
@Module({
  imports: [
    QueuesPlatformModule,
    VirusScanPlatformModule,
    ChannelConnectionsLibModule,
    PluginsModule.forRoot(),
    // The processor of the heavy queue also runs the reconciliation job of the stock
    InventoryReconcileModule,
    // ... and the automatic entries of the books
    FinancePostingWorkerModule,
    // ... and the fiscal documents (TDD_18 §8): the lifecycle submits them through the provider of the issuer
    FiscalRuntimeModule,
    // ... and the nightly retention of a store
    RetentionWorkerModule,
    // ... and the intake of a public data request (Step 7.2-H1a)
    DsrWorkerModule,
    ShippingWorkerModule,
    // The processor of the heavy queue also replays the carrier events kept under a code the owner mapped
    CarriersWorkerModule
  ],
  providers: [
    ProcessorSupport,
    {
      provide: ClamavClient,
      inject: [CLAMAV_ADDRESS],
      useFactory: (address: ClamavAddress) => new ClamavClient(address)
    },
    MediaPipeline,
    UnavailableFileMarker,
    InboundMediaFetcher,
    OriginMediaFetcher,
    OrphanMediaCleaner,
    ExistingPictureSanitizer,
    ExistingDocumentSanitizer,
    VersionedBucketGuard,
    HeavyProcessingProcessor
  ],
  exports: [
    OrphanMediaCleaner,
    ExistingPictureSanitizer,
    ExistingDocumentSanitizer,
    VersionedBucketGuard
  ]
})
export class MediaModule {}
