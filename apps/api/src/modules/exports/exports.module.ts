import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { TenancyModule } from '../tenancy'

import { ExportsController } from './exports.controller'
import { ExportsService } from './exports.service'

// Needs the database and storage modules of the app. ExportsService is exported for the routes that
// make an export (customers, conversations, media).
@Module({
  imports: [QueuesPlatformModule, TenancyModule],
  controllers: [ExportsController],
  providers: [ExportsService],
  exports: [ExportsService]
})
export class ExportsModule {}
