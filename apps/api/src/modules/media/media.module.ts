import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { TenancyModule } from '../tenancy'

import { MediaController } from './media.controller'
import { MediaService } from './media.service'

// Needs the database and storage modules of the app
@Module({
  imports: [QueuesPlatformModule, TenancyModule],
  controllers: [MediaController],
  providers: [MediaService]
})
export class MediaModule {}
