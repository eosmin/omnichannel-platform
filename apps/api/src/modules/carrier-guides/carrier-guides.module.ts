import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { CarrierGuidesController } from './carrier-guides.controller'
import { CarrierGuidesApiService } from './carrier-guides.service'

// The balance of prepaid guides and the refund benefit of a carrier connection (TDD_17 §4.18, §6). The database and the audit
// modules are the app's.
@Module({
  imports: [TenancyModule],
  controllers: [CarrierGuidesController],
  providers: [CarrierGuidesApiService]
})
export class CarrierGuidesModule {}
