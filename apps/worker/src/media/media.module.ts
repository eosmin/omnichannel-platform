import { Module } from '@nestjs/common'

import {
  CLAMAV_ADDRESS,
  type ClamavAddress,
  QueuesPlatformModule,
  VirusScanPlatformModule
} from '@platform/core/http'

import { HeavyProcessingProcessor } from '../processors/heavy-processing.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { ClamavClient } from './clamav.client'
import { MediaPipeline } from './media-pipeline.service'

// The storage, the database and the logger come from the platform module of the worker; the queue of
// the heavy jobs from QueuesPlatformModule; the address of ClamAV from VirusScanPlatformModule.
@Module({
  imports: [QueuesPlatformModule, VirusScanPlatformModule],
  providers: [
    ProcessorSupport,
    {
      provide: ClamavClient,
      inject: [CLAMAV_ADDRESS],
      useFactory: (address: ClamavAddress) => new ClamavClient(address)
    },
    MediaPipeline,
    HeavyProcessingProcessor
  ]
})
export class MediaModule {}
