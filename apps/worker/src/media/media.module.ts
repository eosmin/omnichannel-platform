import { Module } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

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
import { CredentialsResealWorkerModule } from '../credentials/credentials-reseal.module'
import { FinancePostingWorkerModule } from '../finance/finance-posting.module'
import { InventoryReconcileModule } from '../inventory/inventory.module'
import { HeavyProcessingProcessor } from '../processors/heavy-processing.processor'
import { ProcessorSupport } from '../processors/processor-support'
import { RetentionWorkerModule } from '../retention/retention.module'
import { ShippingWorkerModule } from '../shipping/shipping.module'

import { AvCleaner } from './av-cleaner'
import { ClamavClient } from './clamav.client'
import { DocumentCleaner } from './document-cleaner'
import { ExistingAvSanitizer } from './existing-av-sanitizer.service'
import { ExistingDocumentSanitizer } from './existing-document-sanitizer.service'
import { ExistingPictureSanitizer } from './existing-picture-sanitizer.service'
import { defaultAvToolOptions, FfmpegAvCleaner } from './ffmpeg-av-cleaner'
import { InboundMediaFetcher } from './inbound-media-fetcher.service'
import { MediaPipeline } from './media-pipeline.service'
import { OriginMediaFetcher } from './origin-media-fetcher.service'
import { OrphanMediaCleaner } from './orphan-media-cleaner.service'
import { defaultThreadOptions, ThreadDocumentCleaner } from './thread-document-cleaner'
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
    // ... and the re-seal of the sealed credentials after a rotation of the key (Step 7.3-S11c)
    CredentialsResealWorkerModule,
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
    // The parse of a PDF, a docx or an xlsx runs on a thread with a deadline and a memory limit, never on the event loop of the worker (Step 7.3)
    {
      provide: DocumentCleaner,
      useFactory: () => new ThreadDocumentCleaner(defaultThreadOptions())
    },
    // The metadata of a video or an audio file is cut out by ffmpeg in a process of its own, with limits and a deadline (Step 7.1-J-1). The scan
    // of the media pipeline calls it (J-2); the sweep of stored files (J-3) does not yet
    {
      provide: AvCleaner,
      inject: [PinoLogger],
      useFactory: (logger: PinoLogger) => {
        logger.setContext(FfmpegAvCleaner.name)
        const options = defaultAvToolOptions()
        // Without prlimit only the deadline bounds the child: the image build checks that the worker has it, and this says so if it is gone
        if (options.prlimitPath === null) {
          logger.warn(
            'prlimit is missing: the video and audio tools run with a deadline and no memory limit'
          )
        }
        return new FfmpegAvCleaner(options, logger)
      }
    },
    MediaPipeline,
    UnavailableFileMarker,
    InboundMediaFetcher,
    OriginMediaFetcher,
    OrphanMediaCleaner,
    ExistingPictureSanitizer,
    ExistingDocumentSanitizer,
    ExistingAvSanitizer,
    VersionedBucketGuard,
    HeavyProcessingProcessor
  ],
  exports: [
    AvCleaner,
    OrphanMediaCleaner,
    ExistingPictureSanitizer,
    ExistingDocumentSanitizer,
    ExistingAvSanitizer,
    VersionedBucketGuard
  ]
})
export class MediaModule {}
