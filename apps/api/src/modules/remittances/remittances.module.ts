import { Module } from '@nestjs/common'

import { RemittancesService } from '@platform/core/shipping'

import { TenancyModule } from '../tenancy'

import { RemittancesController } from './remittances.controller'
import { RemittancesApiService } from './remittances.service'

// The remittances of cash collected on delivery and their routes (TDD_17 §4.15, §6). The database, the audit and the event
// modules are the app's.
@Module({
  imports: [TenancyModule],
  controllers: [RemittancesController],
  providers: [RemittancesService, RemittancesApiService]
})
export class RemittancesModule {}
