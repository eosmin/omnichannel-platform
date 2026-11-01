import { Module } from '@nestjs/common'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import {
  CLAMAV_ADDRESS,
  type ClamavAddress,
  QueuesPlatformModule,
  VirusScanPlatformModule
} from '@platform/core/http'
import { PluginsModule } from '@platform/plugins/runtime'

import { HeavyProcessingProcessor } from '../processors/heavy-processing.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { ClamavClient } from './clamav.client'
import { InboundMediaFetcher } from './inbound-media-fetcher.service'
import { MediaPipeline } from './media-pipeline.service'
import { OriginMediaFetcher } from './origin-media-fetcher.service'
import { OrphanMediaCleaner } from './orphan-media-cleaner.service'
import { UnavailableFileMarker } from './unavailable-file-marker.service'

// The storage, the database and the logger come from the platform module of the worker; the queue of
// the heavy jobs from QueuesPlatformModule; the address of ClamAV from VirusScanPlatformModule.
// Also exports the cleaner: the scheduler of the worker module runs it.
@Module({
  imports: [
    QueuesPlatformModule,
    VirusScanPlatformModule,
    ChannelConnectionsLibModule,
    PluginsModule.forRoot()
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
    HeavyProcessingProcessor
  ],
  exports: [OrphanMediaCleaner]
})
export class MediaModule {}
