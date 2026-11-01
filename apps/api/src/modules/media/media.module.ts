import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { ExportsModule } from '../exports'
import { TenancyModule } from '../tenancy'

import { MediaDownloadService } from './media-download.service'
import { MediaController } from './media.controller'
import { MediaService } from './media.service'

// Needs the database and storage modules of the app
@Module({
  imports: [ExportsModule, QueuesPlatformModule, TenancyModule],
  controllers: [MediaController],
  providers: [MediaDownloadService, MediaService],
  // The widget signs the downloads of a visitor with the same rules (clean only, never inline)
  exports: [MediaService]
})
export class MediaModule {}
