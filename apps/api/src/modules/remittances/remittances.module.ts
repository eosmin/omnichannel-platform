import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import { RemittancesService } from '@platform/core/shipping'

import { TenancyModule } from '../tenancy'

import { RemittanceImportsController } from './remittance-imports.controller'
import { RemittanceImportsService } from './remittance-imports.service'
import { RemittanceProfilesService } from './remittance-profiles.service'
import { RemittancesController } from './remittances.controller'
import { RemittancesApiService } from './remittances.service'

// The remittances of cash collected on delivery and their routes (TDD_17 §4.15, §6). The database, the audit, the event, the storage
// and the queue modules are the app's. The import controller comes first: its static routes (`/remittances/import-profiles`) must
// be matched before the one of a remittance by id.
@Module({
  imports: [QueuesPlatformModule, TenancyModule],
  controllers: [RemittanceImportsController, RemittancesController],
  providers: [
    RemittancesService,
    RemittancesApiService,
    RemittanceProfilesService,
    RemittanceImportsService
  ]
})
export class RemittancesModule {}
