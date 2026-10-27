import { Module } from '@nestjs/common'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { AddressesService } from './addresses.service'
import { CustomerMergeService } from './customer-merge.service'
import { CustomerTagsService } from './customer-tags.service'
import { CustomersController } from './customers.controller'
import { CustomersService } from './customers.service'
import { IdentitiesService } from './identities.service'
import { NotesService } from './notes.service'

// Needs the database and audit modules of the app. CustomersService is exported for the inbound
// pipeline (Step 2.6), which resolves the customer behind a handle with findOrCreateByIdentity.
@Module({
  imports: [ChannelRegistryModule, TenancyModule],
  controllers: [CustomersController],
  providers: [
    CustomersService,
    IdentitiesService,
    AddressesService,
    NotesService,
    CustomerTagsService,
    CustomerMergeService
  ],
  exports: [CustomersService]
})
export class CustomersModule {}
